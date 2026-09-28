import {
  RECONNECT_GRACE_MS,
  WS_PING_INTERVAL_MS,
  estimateOffset,
  type C2S,
  type ClockSample,
  type ErrorCode,
  type S2C,
} from "@dubroom/shared";
import { useIdentity } from "../lib/identity.ts";
import { initialGameState, useGame } from "./store.ts";

const FATAL: ErrorCode[] = ["room_not_found", "room_full", "room_locked", "kicked", "bad_name"];

/**
 * WebSocket session with the game server: join, clock sync, heartbeat every 20 s (Cloudflare
 * drops idle sockets, §21.7) and automatic reconnect for up to 60 s (US-5).
 */
class GameClient {
  private ws: WebSocket | null = null;
  private code: string | null = null;
  private spectator = false;
  private samples: ClockSample[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private closedByUs = false;
  private reactionId = 1;

  async connect(code: string, opts: { spectator?: boolean } = {}) {
    this.disconnect();
    this.code = code;
    this.spectator = Boolean(opts.spectator);
    this.closedByUs = false;
    this.attempts = 0;
    useGame.setState({ ...initialGameState, conn: "connecting" });
    await this.open();
  }

  private async open() {
    const id = useIdentity.getState();
    let token: string;
    try {
      token = await id.ensureToken();
    } catch {
      this.scheduleRetry();
      return;
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.send({
        t: "join",
        roomCode: this.code!,
        token,
        name: id.name,
        avatar: id.avatar,
        spectator: this.spectator,
      });
      this.syncClock();
      this.pingTimer = setInterval(() => this.ping(), WS_PING_INTERVAL_MS);
    };
    ws.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(String(e.data)) as S2C);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.ws === ws) this.ws = null;
      if (this.closedByUs || useGame.getState().fatal) return;
      this.scheduleRetry();
    };
  }

  private scheduleRetry() {
    const s = useGame.getState();
    const deadline = s.reconnectDeadline ?? Date.now() + RECONNECT_GRACE_MS;
    if (Date.now() > deadline) {
      useGame.setState({ conn: "offline", reconnectDeadline: null });
      return;
    }
    useGame.setState({ conn: "reconnecting", reconnectDeadline: deadline });
    const delay = Math.min(8000, 500 * 2 ** this.attempts++);
    this.retryTimer = setTimeout(() => void this.open(), delay);
  }

  /** Manual retry after going offline. */
  retry() {
    if (!this.code) return;
    useGame.setState({ conn: "connecting", reconnectDeadline: null });
    this.attempts = 0;
    void this.open();
  }

  private syncClock() {
    this.samples = [];
    for (let i = 0; i < 5; i++) setTimeout(() => this.ping(), i * 250);
  }

  private ping() {
    this.send({ t: "ping", clientNow: Date.now() });
  }

  private onMessage(msg: S2C) {
    switch (msg.t) {
      case "welcome":
        useGame.setState({
          conn: "online",
          reconnectDeadline: null,
          room: msg.room,
          me: msg.playerId,
          fatal: null,
        });
        break;
      case "state":
        useGame.setState({ room: msg.room });
        break;
      case "phase": {
        // the full snapshot (with the new round) follows right after; only reset per-phase bits
        const patch: Partial<ReturnType<typeof useGame.getState>> = {};
        if (msg.phase === "vote" || msg.phase === "pick") patch.myVote = null;
        if (msg.phase !== "watch") patch.playAt = null;
        useGame.setState(patch);
        break;
      }
      case "playAt":
        useGame.setState({
          playAt: { entryId: msg.entryId, index: msg.index, startAt: msg.startAt },
        });
        break;
      case "pong": {
        this.samples.push({
          clientSent: msg.clientNow,
          clientReceived: Date.now(),
          serverNow: msg.serverNow,
        });
        if (this.samples.length > 12) this.samples.shift();
        const est = estimateOffset(this.samples);
        if (est) useGame.setState({ serverOffset: est.offset, rtt: est.rtt });
        break;
      }
      case "uploadTicket":
        useGame.setState({
          ticket: { ticket: msg.ticket, round: msg.round, expiresAt: msg.expiresAt },
        });
        break;
      case "myVote":
        useGame.setState({ myVote: msg.entryId });
        break;
      case "reaction": {
        const id = this.reactionId++;
        const item = { id, emoji: msg.emoji, x: 10 + Math.random() * 80, playerId: msg.playerId };
        useGame.setState((s) => ({ reactions: [...s.reactions.slice(-20), item] }));
        setTimeout(
          () => useGame.setState((s) => ({ reactions: s.reactions.filter((r) => r.id !== id) })),
          2300,
        );
        break;
      }
      case "error":
        if (FATAL.includes(msg.code)) {
          this.closedByUs = true;
          useGame.setState({ fatal: msg.code, conn: "offline" });
          this.ws?.close();
        } else {
          useGame.setState({ lastError: { code: msg.code, message: msg.message, at: Date.now() } });
        }
        break;
    }
  }

  send(msg: C2S) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  disconnect() {
    this.closedByUs = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  leave() {
    this.send({ t: "leave" });
    this.disconnect();
    useGame.setState({ ...initialGameState });
  }
}

export const game = new GameClient();

export async function createRoom(): Promise<string> {
  const r = await fetch("/api/rooms", { method: "POST" });
  if (!r.ok) throw new Error(String(r.status));
  return ((await r.json()) as { code: string }).code;
}

export async function roomExists(code: string): Promise<boolean> {
  const r = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
  return r.ok;
}

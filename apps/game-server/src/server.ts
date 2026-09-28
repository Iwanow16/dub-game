import { randomInt } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  WS_MAX_MESSAGES_PER_SEC,
  WS_MAX_MESSAGE_BYTES,
  WS_PING_INTERVAL_MS,
  generateRoomCode,
  normalizeRoomCode,
  parseC2S,
  type CatalogEntry,
  type S2C,
} from "@dubroom/shared";
import { issueUploadTicket, verifyDubReceipt, verifyGuestToken } from "@dubroom/shared/token";
import { GameError, Room, type Conn } from "./room.ts";

export interface ServerConfig {
  signingKeys: string[];
  /** allowed Origin values for WebSocket upgrades; empty = allow any (dev) */
  allowedOrigins: string[];
  trustCfIp: boolean;
  catalog: () => Promise<CatalogEntry[]>;
  maxRooms: number;
  roomIdleMs: number;
  log: (msg: string, extra?: object) => void;
}

const MAX_CONNS_PER_PLAYER = 3;
const JOIN_TIMEOUT_MS = 10_000;

/** Fixed-window limiter keyed by IP (room creation: 10/min, §22.9). */
class WindowLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  allow(key: string, now = Date.now()) {
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      if (this.hits.size > 10_000) this.sweep(now);
      return true;
    }
    return ++h.n <= this.max;
  }
  private sweep(now: number) {
    for (const [k, h] of this.hits) if (h.reset < now) this.hits.delete(k);
  }
}

export function cachedCatalog(apiUrl: string, ttlMs = 60_000): () => Promise<CatalogEntry[]> {
  let cache: { at: number; clips: CatalogEntry[] } | null = null;
  return async () => {
    if (cache && Date.now() - cache.at < ttlMs) return cache.clips;
    const res = await fetch(`${apiUrl.replace(/\/$/, "")}/api/catalog`);
    if (!res.ok) throw new Error(`catalog: ${res.status}`);
    const data = (await res.json()) as { clips: CatalogEntry[] };
    cache = { at: Date.now(), clips: data.clips };
    return data.clips;
  };
}

export class GameServer {
  readonly rooms = new Map<string, Room>();
  /** set on shutdown: existing rooms keep playing, no new rooms are created */
  draining = false;
  readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly createLimiter = new WindowLimiter(10, 60_000);
  private readonly joinLimiter = new WindowLimiter(30, 60_000);
  private nextConnId = 1;
  private sweepTimer: ReturnType<typeof setInterval>;
  private pingTimer: ReturnType<typeof setInterval>;

  constructor(private readonly cfg: ServerConfig) {
    this.http = createServer((req, res) => void this.onHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_MESSAGE_BYTES });
    this.http.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://x");
      const origin = req.headers.origin ?? "";
      if (
        url.pathname !== "/ws" ||
        (cfg.allowedOrigins.length > 0 && !cfg.allowedOrigins.includes(origin))
      ) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, req));
    });
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.pingTimer = setInterval(() => {
      for (const ws of this.wss.clients) {
        const alive = ws as WebSocket & { alive?: boolean };
        if (alive.alive === false) {
          ws.terminate();
          continue;
        }
        alive.alive = false;
        ws.ping();
      }
    }, WS_PING_INTERVAL_MS);
  }

  private ip(req: IncomingMessage): string {
    const cf = req.headers["cf-connecting-ip"];
    if (this.cfg.trustCfIp && typeof cf === "string" && cf) return cf;
    return req.socket.remoteAddress ?? "unknown";
  }

  createRoom(): Room | null {
    if (this.draining || this.rooms.size >= this.cfg.maxRooms) return null;
    let code: string;
    do code = generateRoomCode((max) => randomInt(max));
    while (this.rooms.has(code));
    const room = new Room(code, {
      catalog: this.cfg.catalog,
      issueTicket: (roomCode, round, playerId, opts) =>
        issueUploadTicket(roomCode, round, playerId, this.cfg.signingKeys[0]!, opts).ticket,
      verifyReceipt: (r) => verifyDubReceipt(r, this.cfg.signingKeys),
      onEmpty: (r) => this.dropRoom(r.code),
      log: this.cfg.log,
    });
    this.rooms.set(code, room);
    this.cfg.log("room created", { room: code, rooms: this.rooms.size });
    return room;
  }

  private dropRoom(code: string) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.dispose();
    this.rooms.delete(code);
    this.cfg.log("room closed", { room: code, rooms: this.rooms.size });
  }

  /** Rooms without connected players expire after ROOM_IDLE (2 h, §7). */
  private sweep() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      const idle = room.connectedCount === 0 && now - room.lastActivity > this.cfg.roomIdleMs;
      if (idle || room.size === 0) this.dropRoom(room.code);
    }
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body));
  }

  private async onHttp(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/api/game/health") {
      return this.json(res, 200, {
        ok: true,
        service: "game-server",
        rooms: this.rooms.size,
        sockets: this.wss.clients.size,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/rooms") {
      if (!this.createLimiter.allow(this.ip(req)))
        return this.json(res, 429, { error: "rate_limited" });
      const room = this.createRoom();
      return room
        ? this.json(res, 201, { code: room.code })
        : this.json(res, 503, { error: "capacity" });
    }
    const m = /^\/api\/rooms\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      const code = normalizeRoomCode(decodeURIComponent(m[1]!));
      const room = code ? this.rooms.get(code) : undefined;
      if (!room) return this.json(res, 404, { error: "room_not_found" });
      const players = room.snapshot("").players;
      return this.json(res, 200, {
        code: room.code,
        phase: room.phase,
        players: players.filter((p) => !p.spectator).length,
        spectators: players.filter((p) => p.spectator).length,
        locked: room.settings.locked,
      });
    }
    this.json(res, 404, { error: "not_found" });
  }

  private onSocket(ws: WebSocket, req: IncomingMessage) {
    const ip = this.ip(req);
    const conn: Conn = {
      id: this.nextConnId++,
      send: (msg: S2C) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      close: (code, reason) => ws.close(code, reason),
    };
    const alive = ws as WebSocket & { alive?: boolean };
    alive.alive = true;
    ws.on("pong", () => (alive.alive = true));

    let room: Room | null = null;
    let playerId: string | null = null;
    let bucket = WS_MAX_MESSAGES_PER_SEC;
    let bucketAt = Date.now();
    let strikes = 0;
    const joinTimer = setTimeout(() => {
      if (!room) ws.close(4000, "join timeout");
    }, JOIN_TIMEOUT_MS);

    const fail = (code: GameError["code"], message?: string) =>
      conn.send({ t: "error", code, message });

    ws.on("message", (data, isBinary) => {
      // token bucket: 20 msg/s (§22.10)
      const now = Date.now();
      bucket = Math.min(
        WS_MAX_MESSAGES_PER_SEC,
        bucket + ((now - bucketAt) / 1000) * WS_MAX_MESSAGES_PER_SEC,
      );
      bucketAt = now;
      if (bucket < 1) {
        if (++strikes > 50) ws.close(4008, "rate limited");
        return fail("rate_limited");
      }
      bucket -= 1;

      if (isBinary) return fail("bad_message");
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return fail("bad_message");
      }
      const msg = parseC2S(raw);
      if (!msg) return fail("bad_message");

      if (msg.t === "ping")
        return conn.send({ t: "pong", clientNow: msg.clientNow, serverNow: Date.now() });

      try {
        if (msg.t === "join") {
          if (room) return fail("not_allowed", "already joined");
          if (!this.joinLimiter.allow(ip)) return fail("rate_limited");
          const guest = verifyGuestToken(msg.token, this.cfg.signingKeys);
          if (!guest) return fail("bad_token");
          const code = normalizeRoomCode(msg.roomCode);
          const target = code ? this.rooms.get(code) : undefined;
          if (!target) return fail("room_not_found");
          if (target.connectionsOf(guest.sub) >= MAX_CONNS_PER_PLAYER)
            return fail("too_many_connections");
          target.join(conn, guest.sub, msg);
          room = target;
          playerId = guest.sub;
          clearTimeout(joinTimer);
          return;
        }
        if (!room || !playerId) return fail("not_allowed", "join first");
        room.handle(playerId, msg);
      } catch (e) {
        if (e instanceof GameError) return fail(e.code, e.message);
        this.cfg.log("handler error", { error: String(e) });
        fail("bad_message");
      }
    });

    ws.on("close", () => {
      clearTimeout(joinTimer);
      if (room && playerId) room.disconnect(conn, playerId);
    });
    ws.on("error", () => ws.terminate());
  }

  listen(port: number, host = "0.0.0.0") {
    return new Promise<void>((resolve) => this.http.listen(port, host, resolve));
  }

  async close() {
    clearInterval(this.sweepTimer);
    clearInterval(this.pingTimer);
    for (const room of this.rooms.values()) room.dispose();
    for (const ws of this.wss.clients) ws.close(1001, "server shutting down");
    this.wss.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

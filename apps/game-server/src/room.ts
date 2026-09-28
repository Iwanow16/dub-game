import {
  DEFAULT_SETTINGS,
  MAX_PLAYERS,
  MAX_SPECTATORS,
  PHASE_MS,
  RECONNECT_GRACE_MS,
  assignTeams,
  nextHost,
  pickCandidates,
  recordPhaseMs,
  resolvePick,
  sanitizeName,
  scoreRound,
  timerMs,
  uniquifyName,
  type AvatarSpec,
  type C2S,
  expandPlayables,
  maxDubBytes,
  type CatalogEntry,
  type DubTrack,
  type EffectId,
  type Entry,
  type ErrorCode,
  type Phase,
  type PlayerPublic,
  type RoomSettings,
  type RoomSnapshot,
  type RoundState,
  type S2C,
} from "@dubroom/shared";

export interface Conn {
  id: number;
  send(msg: S2C): void;
  close(code?: number, reason?: string): void;
}

export interface RoomDeps {
  catalog: () => Promise<CatalogEntry[]>;
  issueTicket: (
    room: string,
    round: number,
    playerId: string,
    opts: { ttlMs: number; maxBytes: number },
  ) => string;
  verifyReceipt: (
    receipt: string,
  ) => { dub: string; room: string; round: number; sub: string } | null;
  now?: () => number;
  rand?: () => number;
  onEmpty?: (room: Room) => void;
  log?: (msg: string, extra?: object) => void;
}

interface Member extends PlayerPublic {
  conns: Set<Conn>;
  disconnectedAt: number | null;
  removeTimer: ReturnType<typeof setTimeout> | null;
  lastReactionAt: number;
  reactionBurst: number;
}

interface Take {
  dubId: string;
  offsetMs: number;
  effect: EffectId;
  gain: number;
}

interface RoundInternal extends Omit<RoundState, "myEntryId" | "votesCast"> {
  takes: Map<string, Take>;
  votes: Map<string, string>;
  playOrder: number[];
}

export class GameError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** Lead time so every client receives `playAt` before the start instant (§13). */
const PLAY_LEAD_MS = 1500;
const REACTIONS_PER_SEC = 3;

/**
 * Authoritative state of one room (§6.4): the only source of truth for phases and timers.
 * All client input arrives through `handle()`, state leaves through per-viewer snapshots.
 */
export class Room {
  readonly code: string;
  readonly createdAt: number;
  settings: RoomSettings = { ...DEFAULT_SETTINGS };
  phase: Phase = "lobby";
  endsAt: number | null = null;
  lastActivity: number;
  private members = new Map<string, Member>();
  private banned = new Set<string>();
  private hostId: string | null = null;
  private round: RoundInternal | null = null;
  /** playable ids (clip or clip#scene) already played in this room */
  private played = new Set<string>();
  private bestOfGame: RoomSnapshot["bestOfGame"] = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private v = 0;
  private readonly now: () => number;
  private readonly rand: () => number;

  constructor(
    code: string,
    private readonly deps: RoomDeps,
  ) {
    this.code = code;
    this.now = deps.now ?? Date.now;
    this.rand = deps.rand ?? Math.random;
    this.createdAt = this.now();
    this.lastActivity = this.createdAt;
  }

  get size() {
    return this.members.size;
  }

  get connectedCount() {
    let n = 0;
    for (const m of this.members.values()) if (m.conns.size > 0) n++;
    return n;
  }

  connectionsOf(playerId: string) {
    return this.members.get(playerId)?.conns.size ?? 0;
  }

  /* ---------------- membership ---------------- */

  join(
    conn: Conn,
    playerId: string,
    msg: { name: string; avatar: AvatarSpec; spectator?: boolean },
  ) {
    this.lastActivity = this.now();
    if (this.banned.has(playerId)) throw new GameError("kicked");
    const existing = this.members.get(playerId);
    if (existing) {
      // reconnect (US-5): same seat, score and role
      existing.conns.add(conn);
      existing.connected = true;
      existing.disconnectedAt = null;
      if (existing.removeTimer) clearTimeout(existing.removeTimer);
      existing.removeTimer = null;
      this.welcome(conn, existing);
      this.broadcast();
      return;
    }

    const name = sanitizeName(msg.name);
    if (!name.ok) throw new GameError("bad_name", name.error);
    const inGame = this.phase !== "lobby" && this.phase !== "final";
    if (inGame && this.settings.locked) throw new GameError("room_locked");
    const players = [...this.members.values()].filter((m) => !m.spectator);
    const spectators = this.members.size - players.length;
    const spectator = Boolean(msg.spectator) || inGame || players.length >= MAX_PLAYERS;
    if (spectator && spectators >= MAX_SPECTATORS) throw new GameError("room_full");

    const member: Member = {
      id: playerId,
      name: uniquifyName(
        name.name,
        [...this.members.values()].map((m) => m.name),
      ),
      avatar: msg.avatar,
      spectator,
      connected: true,
      isHost: false,
      score: 0,
      status: "idle",
      progress: 0,
      joinedAt: this.now(),
      conns: new Set([conn]),
      disconnectedAt: null,
      removeTimer: null,
      lastReactionAt: 0,
      reactionBurst: 0,
    };
    this.members.set(playerId, member);
    if (!this.hostId) this.setHost(playerId);
    this.welcome(conn, member);
    this.broadcast();
  }

  private welcome(conn: Conn, m: Member) {
    conn.send({
      t: "welcome",
      playerId: m.id,
      room: this.snapshot(m.id),
      v: this.v,
      serverNow: this.now(),
    });
    if (this.phase === "record" && this.round?.participants.includes(m.id)) {
      this.sendTicket(m);
    }
  }

  disconnect(conn: Conn, playerId: string) {
    const m = this.members.get(playerId);
    if (!m || !m.conns.delete(conn)) return;
    if (m.conns.size > 0) return;
    m.connected = false;
    m.disconnectedAt = this.now();
    m.removeTimer = setTimeout(() => this.remove(playerId), RECONNECT_GRACE_MS);
    this.broadcast();
    this.checkProgress();
  }

  private remove(playerId: string) {
    const m = this.members.get(playerId);
    if (!m) return;
    if (m.removeTimer) clearTimeout(m.removeTimer);
    this.members.delete(playerId);
    if (this.round) {
      this.round.participants = this.round.participants.filter((id) => id !== playerId);
      this.round.votes.delete(playerId);
      delete this.round.pickVotes[playerId];
    }
    if (this.hostId === playerId) this.setHost(nextHost(this.publicPlayers()));
    if (this.members.size === 0) {
      this.clearTimer();
      this.deps.onEmpty?.(this);
      return;
    }
    this.broadcast();
    this.checkProgress();
  }

  private setHost(id: string | null) {
    this.hostId = id;
    for (const m of this.members.values()) m.isHost = m.id === id;
  }

  /* ---------------- input ---------------- */

  handle(playerId: string, msg: C2S) {
    const m = this.members.get(playerId);
    if (!m) throw new GameError("not_allowed");
    this.lastActivity = this.now();
    const host = () => {
      if (!m.isHost) throw new GameError("not_host");
    };
    const inPhase = (...phases: Phase[]) => {
      if (!phases.includes(this.phase)) throw new GameError("wrong_phase");
    };

    switch (msg.t) {
      case "leave":
        for (const c of m.conns) c.close(1000, "left");
        this.remove(playerId);
        return;

      case "settings": {
        host();
        inPhase("lobby", "final");
        this.settings = { ...this.settings, ...msg.settings };
        break;
      }

      case "start": {
        host();
        inPhase("lobby");
        const active = this.activePlayers();
        if (active.length < 2) throw new GameError("not_allowed", "нужно минимум 2 игрока");
        for (const p of this.members.values()) p.score = 0;
        this.bestOfGame = null;
        void this.startRound(1);
        return;
      }

      case "kick": {
        host();
        if (msg.playerId === playerId) throw new GameError("not_allowed");
        const target = this.members.get(msg.playerId);
        if (!target) return;
        this.banned.add(target.id);
        for (const c of target.conns) {
          c.send({ t: "error", code: "kicked" });
          c.close(4001, "kicked");
        }
        this.remove(target.id);
        return;
      }

      case "rename": {
        host();
        const target = this.members.get(msg.playerId);
        const name = sanitizeName(msg.name);
        if (!target) return;
        if (!name.ok) throw new GameError("bad_name", name.error);
        target.name = uniquifyName(
          name.name,
          [...this.members.values()].filter((x) => x.id !== target.id).map((x) => x.name),
        );
        break;
      }

      case "becomeSpectator": {
        inPhase("lobby", "final");
        if (!msg.spectator && m.spectator) {
          const players = [...this.members.values()].filter((x) => !x.spectator).length;
          if (players >= MAX_PLAYERS) throw new GameError("room_full");
        }
        m.spectator = msg.spectator;
        break;
      }

      case "pickClip": {
        inPhase("pick");
        const r = this.round!;
        if (!r.candidates.some((c) => c.id === msg.clipId)) throw new GameError("bad_message");
        if (this.settings.clipPick === "host") {
          host();
          r.pickVotes = { [playerId]: msg.clipId };
          this.endPick();
          return;
        }
        if (!r.participants.includes(playerId)) throw new GameError("not_allowed");
        r.pickVotes[playerId] = msg.clipId;
        m.status = "done";
        this.broadcast();
        this.checkProgress();
        return;
      }

      case "ready":
        inPhase("record");
        if (m.status === "loading" || m.status === "idle") m.status = "ready";
        break;

      case "status":
        inPhase("record");
        if (m.status === "done") return;
        m.status = msg.status;
        m.progress = msg.progress ?? 0;
        break;

      case "dubUploaded": {
        inPhase("record");
        const r = this.round!;
        if (!r.participants.includes(playerId)) throw new GameError("not_allowed");
        const receipt = this.deps.verifyReceipt(msg.receipt);
        if (
          !receipt ||
          receipt.room !== this.code ||
          receipt.round !== r.index ||
          receipt.sub !== playerId
        ) {
          throw new GameError("not_allowed", "bad receipt");
        }
        r.takes.set(playerId, {
          dubId: receipt.dub,
          offsetMs: msg.offsetMs,
          effect: msg.effect,
          gain: msg.gain,
        });
        m.status = "done";
        m.progress = 1;
        this.broadcast();
        this.checkProgress();
        return;
      }

      case "vote": {
        inPhase("vote");
        const r = this.round!;
        const entry = r.entries.find((e) => e.id === msg.entryId);
        if (!entry || entry.lost) throw new GameError("bad_message");
        if (entry.playerIds.includes(playerId)) throw new GameError("not_allowed", "self vote");
        r.votes.set(playerId, entry.id);
        m.status = "done";
        for (const c of m.conns) c.send({ t: "myVote", entryId: entry.id });
        this.broadcast();
        this.checkProgress();
        return;
      }

      case "reaction": {
        inPhase("watch", "vote", "results");
        const now = this.now();
        if (now - m.lastReactionAt > 1000) {
          m.lastReactionAt = now;
          m.reactionBurst = 0;
        }
        if (++m.reactionBurst > REACTIONS_PER_SEC) return;
        this.send({ t: "reaction", playerId, emoji: msg.emoji });
        return;
      }

      case "playAgain":
        host();
        inPhase("final");
        this.clearTimer();
        this.round = null;
        this.bestOfGame = null;
        this.setPhase("lobby", null);
        for (const p of this.members.values()) {
          p.score = 0;
          p.status = "idle";
        }
        break;

      case "skipPhase":
        host();
        this.skip();
        return;

      case "join":
      case "ping":
        return; // handled by the server
    }
    this.broadcast();
  }

  /* ---------------- phases ---------------- */

  private activePlayers() {
    return [...this.members.values()].filter((m) => !m.spectator && m.connected);
  }

  private setPhase(phase: Phase, durationMs: number | null) {
    this.phase = phase;
    this.endsAt = durationMs == null ? null : this.now() + durationMs;
    this.clearTimer();
    this.send({ t: "phase", phase, endsAt: this.endsAt });
  }

  private schedule(ms: number, fn: () => void) {
    this.clearTimer();
    this.timer = setTimeout(fn, ms);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private resetStatuses(status: PlayerPublic["status"] = "idle") {
    for (const m of this.members.values()) {
      m.status = status;
      m.progress = 0;
    }
  }

  private async startRound(index: number) {
    const catalog = await this.deps.catalog().catch(() => [] as CatalogEntry[]);
    const playables = expandPlayables(catalog, this.settings.segment);
    const candidates = pickCandidates(playables, this.settings, this.played, 3, this.rand);
    if (candidates.length === 0) {
      this.send({ t: "error", code: "not_allowed", message: "в библиотеке нет подходящих клипов" });
      this.setPhase("lobby", null);
      this.broadcast();
      return;
    }
    this.round = {
      index,
      participants: [...this.members.values()].filter((m) => !m.spectator).map((m) => m.id),
      candidates,
      pickVotes: {},
      clip: null,
      roleAssignment: {},
      teams: [],
      entries: [],
      watching: -1,
      results: null,
      takes: new Map(),
      votes: new Map(),
      playOrder: [],
    };
    this.resetStatuses();
    const ms = timerMs(PHASE_MS.pick, this.settings.relaxedTimers);
    this.setPhase("pick", ms);
    this.schedule(ms, () => this.endPick());
    this.broadcast();
  }

  private endPick() {
    const r = this.round!;
    r.clip = resolvePick(r.candidates, r.pickVotes, this.rand);
    if (!r.clip) return;
    this.played.add(r.clip.id);
    if (this.settings.mode === "roles") {
      const roleIds = r.clip.scene?.roleIds.length
        ? r.clip.scene.roleIds
        : Array.from({ length: Math.max(1, r.clip.rolesCount) }, (_, i) => `r${i + 1}`);
      const { teams, assignment } = assignTeams(r.participants, roleIds);
      r.teams = teams;
      r.roleAssignment = assignment;
    }
    this.resetStatuses();
    for (const id of r.participants) this.members.get(id)!.status = "loading";
    const ms = recordPhaseMs(r.clip.durationMs, this.settings.relaxedTimers);
    this.setPhase("record", ms);
    for (const id of r.participants) this.sendTicket(this.members.get(id)!);
    this.schedule(ms, () => this.endRecord());
    this.broadcast();
  }

  private sendTicket(m: Member) {
    if (!this.round || this.endsAt == null) return;
    const ttl = Math.max(60_000, this.endsAt - this.now() + 5 * 60_000);
    const ticket = this.deps.issueTicket(this.code, this.round.index, m.id, {
      ttlMs: ttl,
      maxBytes: maxDubBytes(this.round.clip?.durationMs ?? 0),
    });
    for (const c of m.conns) {
      c.send({ t: "uploadTicket", ticket, round: this.round.index, expiresAt: this.now() + ttl });
    }
  }

  private endRecord() {
    const r = this.round!;
    const track = (playerId: string, roles: string[]): DubTrack | null => {
      const take = r.takes.get(playerId);
      return take ? { playerId, roles, ...take } : null;
    };
    const groups =
      this.settings.mode === "roles" && r.teams.length ? r.teams : r.participants.map((id) => [id]);
    const entries: Entry[] = groups.map((ids) => {
      const tracks = ids
        .map((id) => track(id, r.roleAssignment[id] ?? []))
        .filter((t): t is DubTrack => t !== null);
      return { id: "", playerIds: ids, tracks, lost: tracks.length === 0 };
    });
    // shuffle so the order does not reveal authors, then number
    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [entries[i], entries[j]] = [entries[j]!, entries[i]!];
    }
    entries.forEach((e, i) => (e.id = `e${i + 1}`));
    r.entries = entries;
    r.playOrder = entries.map((e, i) => (e.lost ? -1 : i)).filter((i) => i >= 0);
    this.resetStatuses();

    if (r.playOrder.length === 0) {
      // nobody uploaded anything — straight to results
      this.endVote();
      return;
    }
    const clipMs = r.clip!.durationMs;
    const total = r.playOrder.length * (PLAY_LEAD_MS + clipMs + PHASE_MS.watchGap);
    this.setPhase("watch", total);
    this.broadcast();
    this.playEntry(0);
  }

  private playEntry(k: number) {
    const r = this.round!;
    if (k >= r.playOrder.length) {
      this.startVote();
      return;
    }
    const index = r.playOrder[k]!;
    r.watching = index;
    const startAt = this.now() + PLAY_LEAD_MS;
    this.send({ t: "playAt", entryId: r.entries[index]!.id, index: k, startAt });
    this.broadcast();
    this.schedule(PLAY_LEAD_MS + r.clip!.durationMs + PHASE_MS.watchGap, () =>
      this.playEntry(k + 1),
    );
  }

  private startVote() {
    const r = this.round!;
    r.watching = -1;
    this.resetStatuses();
    const ms = timerMs(PHASE_MS.vote, this.settings.relaxedTimers);
    this.setPhase("vote", ms);
    this.schedule(ms, () => this.endVote());
    this.broadcast();
    this.checkProgress();
  }

  private endVote() {
    const r = this.round!;
    const votes = [...r.votes.entries()].map(([voterId, entryId]) => ({
      voterId,
      entryId,
      spectator: this.members.get(voterId)?.spectator ?? true,
    }));
    r.results = scoreRound(r.entries, votes);
    for (const res of r.results) {
      const entry = r.entries.find((e) => e.id === res.entryId)!;
      for (const id of entry.playerIds) {
        const m = this.members.get(id);
        if (m) m.score += res.points;
      }
      if (
        !entry.lost &&
        res.votes + res.spectatorVotes > 0 &&
        (!this.bestOfGame || res.votes + res.spectatorVotes > this.bestOfGame.votes)
      ) {
        this.bestOfGame = {
          round: r.index,
          clip: r.clip!,
          entry,
          votes: res.votes + res.spectatorVotes,
        };
      }
    }
    this.resetStatuses();
    const ms = timerMs(PHASE_MS.results, this.settings.relaxedTimers);
    this.setPhase("results", ms);
    this.schedule(ms, () => this.afterResults());
    this.broadcast();
  }

  private afterResults() {
    const r = this.round!;
    if (r.index < this.settings.rounds && this.activePlayers().length >= 1) {
      void this.startRound(r.index + 1);
    } else {
      this.setPhase("final", null);
      this.broadcast();
    }
  }

  private skip() {
    switch (this.phase) {
      case "pick":
        return this.endPick();
      case "record":
        return this.endRecord();
      case "watch":
        return this.startVote();
      case "vote":
        return this.endVote();
      case "results":
        return this.afterResults();
    }
  }

  /** Ends a phase early when everyone who can act has acted. */
  private checkProgress() {
    const r = this.round;
    if (!r) return;
    const connected = r.participants.filter((id) => this.members.get(id)?.connected);
    if (this.phase === "pick" && this.settings.clipPick === "vote") {
      if (connected.length > 0 && connected.every((id) => r.pickVotes[id])) this.endPick();
    } else if (this.phase === "record") {
      if (connected.length > 0 && connected.every((id) => r.takes.has(id))) this.endRecord();
    } else if (this.phase === "vote") {
      const voters = [...this.members.values()].filter((m) => {
        if (!m.connected) return false;
        // someone whose only option would be their own entry can't vote
        return r.entries.some((e) => !e.lost && !e.playerIds.includes(m.id));
      });
      if (voters.length > 0 && voters.every((m) => r.votes.has(m.id))) this.endVote();
    }
  }

  /* ---------------- output ---------------- */

  private publicPlayers(): PlayerPublic[] {
    return [...this.members.values()].map(
      ({
        conns: _c,
        disconnectedAt: _d,
        removeTimer: _t,
        lastReactionAt: _l,
        reactionBurst: _b,
        ...p
      }) => p,
    );
  }

  snapshot(viewerId: string): RoomSnapshot {
    const r = this.round;
    const hide = this.settings.anonymous && (this.phase === "watch" || this.phase === "vote");
    let round: RoundState | null = null;
    if (r) {
      const mine = r.entries.find((e) => e.playerIds.includes(viewerId));
      round = {
        index: r.index,
        participants: r.participants,
        candidates: r.candidates,
        pickVotes: r.pickVotes,
        clip: r.clip,
        roleAssignment: r.roleAssignment,
        teams: r.teams,
        entries: hide
          ? r.entries.map((e) => ({
              ...e,
              playerIds: [],
              tracks: e.tracks.map((t) => ({ ...t, playerId: "" })),
            }))
          : r.entries,
        watching: r.watching,
        results: r.results,
        votesCast: r.votes.size,
        myEntryId: mine?.id ?? null,
      };
    }
    return {
      code: this.code,
      settings: this.settings,
      phase: this.phase,
      endsAt: this.endsAt,
      players: this.publicPlayers(),
      round,
      bestOfGame: this.bestOfGame,
    };
  }

  private send(msg: S2C) {
    for (const m of this.members.values()) for (const c of m.conns) c.send(msg);
  }

  broadcast() {
    this.v++;
    for (const m of this.members.values()) {
      if (m.conns.size === 0) continue;
      const room = this.snapshot(m.id);
      for (const c of m.conns) c.send({ t: "state", room, v: this.v });
    }
  }

  dispose() {
    this.clearTimer();
    for (const m of this.members.values()) if (m.removeTimer) clearTimeout(m.removeTimer);
  }
}

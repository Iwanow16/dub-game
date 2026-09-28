import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AVATAR_PRESETS,
  RECONNECT_GRACE_MS,
  type C2S,
  type CatalogEntry,
  type S2C,
} from "@dubroom/shared";
import { GameError, Room, type Conn } from "./room.ts";

const clip = (id: string, rolesCount = 1): CatalogEntry => ({
  id,
  slug: id,
  version: 1,
  title: { ru: id },
  durationMs: 10_000,
  rolesCount,
  ageRating: "0+",
  tags: [],
  credit: "",
  manifestUrl: "",
  posterUrl: "",
  previewUrl: null,
  scenes: [],
});

class FakeConn implements Conn {
  static next = 1;
  id = FakeConn.next++;
  inbox: S2C[] = [];
  closed = false;
  send(msg: S2C) {
    this.inbox.push(msg);
  }
  close() {
    this.closed = true;
  }
  last<T extends S2C["t"]>(t: T) {
    return [...this.inbox].reverse().find((m) => m.t === t) as Extract<S2C, { t: T }> | undefined;
  }
  get state() {
    return this.last("state")?.room ?? this.last("welcome")?.room;
  }
}

let room: Room;
const conns = new Map<string, FakeConn>();
const flush = () => vi.advanceTimersByTimeAsync(0);

function makeRoom(catalog = [clip("a"), clip("b"), clip("c"), clip("d", 2)]) {
  return new Room("ABCDE", {
    catalog: async () => catalog,
    issueTicket: (r, round, pid) => `ticket:${r}:${round}:${pid}`,
    verifyReceipt: (receipt) => {
      const [, dub, r, round, sub] = receipt.split(":");
      return { dub: dub!, room: r!, round: Number(round), sub: sub! };
    },
    rand: () => 0.1,
  });
}

function join(id: string, name = id, spectator = false) {
  const c = new FakeConn();
  conns.set(id, c);
  room.join(c, id, { name, avatar: AVATAR_PRESETS[0]!, spectator });
  return c;
}

const act = (id: string, msg: C2S) => room.handle(id, msg);

beforeEach(() => {
  vi.useFakeTimers();
  conns.clear();
  room = makeRoom();
});
afterEach(() => {
  room.dispose();
  vi.useRealTimers();
});

describe("room membership", () => {
  it("makes the first player host, uniquifies names, rejects bad names", () => {
    join("p1", "Аня");
    const c2 = join("p2", "аня");
    const s = c2.state!;
    expect(s.players.map((p) => p.name)).toEqual(["Аня", "аня 2"]);
    expect(s.players.find((p) => p.id === "p1")!.isHost).toBe(true);
    expect(() =>
      room.join(new FakeConn(), "p3", { name: "x", avatar: AVATAR_PRESETS[0]! }),
    ).toThrow(GameError);
  });

  it("puts the 7th player into spectators", () => {
    for (let i = 1; i <= 7; i++) join(`p${i}`, `Игрок ${i}`);
    const s = conns.get("p7")!.state!;
    expect(s.players.filter((p) => !p.spectator)).toHaveLength(6);
    expect(s.players.find((p) => p.id === "p7")!.spectator).toBe(true);
  });

  it("restores the seat on reconnect within 60 s and migrates host after", async () => {
    const c1 = join("p1", "Аня");
    join("p2", "Петя");
    room.disconnect(c1, "p1");
    expect(conns.get("p2")!.state!.players.find((p) => p.id === "p1")!.connected).toBe(false);
    const again = new FakeConn();
    room.join(again, "p1", { name: "другое", avatar: AVATAR_PRESETS[1]! });
    let p1 = again.state!.players.find((p) => p.id === "p1")!;
    expect(p1).toMatchObject({ connected: true, name: "Аня", isHost: true });

    room.disconnect(again, "p1");
    await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_MS + 10);
    const s = conns.get("p2")!.state!;
    expect(s.players.map((p) => p.id)).toEqual(["p2"]);
    p1 = s.players[0]!;
    expect(p1.isHost).toBe(true);
  });

  it("only the host can change settings, start and kick; kicked players can't return", () => {
    join("p1", "Аня");
    join("p2", "Петя");
    expect(() => act("p2", { t: "start" })).toThrow("not_host");
    act("p1", { t: "settings", settings: { rounds: 3, anonymous: false } });
    expect(conns.get("p2")!.state!.settings.rounds).toBe(3);
    act("p1", { t: "kick", playerId: "p2" });
    expect(conns.get("p2")!.closed).toBe(true);
    expect(() => join("p2", "Петя")).toThrow("kicked");
  });

  it("needs two players to start", () => {
    join("p1", "Аня");
    expect(() => act("p1", { t: "start" })).toThrow(GameError);
  });
});

describe("a full game", () => {
  it("plays pick → record → watch → vote → results → final", async () => {
    join("p1", "Аня");
    join("p2", "Петя");
    join("p3", "Лёша");
    join("s1", "Зритель", true);
    act("p1", { t: "settings", settings: { rounds: 3, anonymous: true } });
    act("p1", { t: "start" });
    await flush();

    let s = conns.get("p1")!.state!;
    expect(s.phase).toBe("pick");
    expect(s.round!.candidates).toHaveLength(3);
    expect(s.round!.participants.sort()).toEqual(["p1", "p2", "p3"]);
    const pick = s.round!.candidates[1]!.id;
    for (const p of ["p1", "p2", "p3"]) act(p, { t: "pickClip", clipId: pick });

    s = conns.get("p1")!.state!;
    expect(s.phase).toBe("record");
    expect(s.round!.clip!.id).toBe(pick);
    expect(conns.get("p2")!.last("uploadTicket")).toMatchObject({ ticket: "ticket:ABCDE:1:p2" });
    expect(conns.get("s1")!.last("uploadTicket")).toBeUndefined();

    // a spectator cannot upload, a forged receipt is rejected
    expect(() =>
      act("s1", {
        t: "dubUploaded",
        receipt: "r:x:ABCDE:1:s1",
        offsetMs: 0,
        effect: "none",
        gain: 1,
      }),
    ).toThrow(GameError);
    expect(() =>
      act("p2", {
        t: "dubUploaded",
        receipt: "r:x:ABCDE:1:p3",
        offsetMs: 0,
        effect: "none",
        gain: 1,
      }),
    ).toThrow("bad receipt");

    act("p1", {
      t: "dubUploaded",
      receipt: "r:d1:ABCDE:1:p1",
      offsetMs: -40,
      effect: "robot",
      gain: 1.2,
    });
    act("p2", {
      t: "dubUploaded",
      receipt: "r:d2:ABCDE:1:p2",
      offsetMs: 0,
      effect: "none",
      gain: 1,
    });
    act("p3", {
      t: "dubUploaded",
      receipt: "r:d3:ABCDE:1:p3",
      offsetMs: 0,
      effect: "echo",
      gain: 1,
    });

    s = conns.get("p1")!.state!;
    expect(s.phase).toBe("watch");
    expect(s.round!.entries).toHaveLength(3);
    // anonymous: authors hidden, but each player knows their own entry
    expect(s.round!.entries.every((e) => e.playerIds.length === 0)).toBe(true);
    const myEntry = s.round!.myEntryId!;
    expect(myEntry).toMatch(/^e\d$/);
    expect(conns.get("p1")!.last("playAt")).toMatchObject({ index: 0 });

    await vi.advanceTimersByTimeAsync(3 * (1500 + 10_000 + 2500) + 100);
    s = conns.get("p1")!.state!;
    expect(s.phase).toBe("vote");

    expect(() => act("p1", { t: "vote", entryId: myEntry })).toThrow("self vote");
    const others = s.round!.entries.filter((e) => e.id !== myEntry);
    const p2Entry = conns.get("p2")!.state!.round!.myEntryId!;
    const p3Entry = conns.get("p3")!.state!.round!.myEntryId!;
    act("p1", { t: "vote", entryId: p2Entry });
    act("p3", { t: "vote", entryId: p2Entry });
    act("p2", { t: "vote", entryId: p3Entry });
    expect(others).toHaveLength(2);
    act("s1", { t: "vote", entryId: p3Entry });

    s = conns.get("p1")!.state!;
    expect(s.phase).toBe("results");
    // revealed after voting
    expect(s.round!.entries.find((e) => e.id === p2Entry)!.playerIds).toEqual(["p2"]);
    const score = (id: string) => s.players.find((p) => p.id === id)!.score;
    expect(score("p2")).toBe(250); // 2 votes + winner bonus
    expect(score("p3")).toBe(175); // 1 vote + spectator 0.5 + audience award
    expect(score("p1")).toBe(0);
    expect(s.bestOfGame!.entry.id).toBe(p2Entry);

    await vi.advanceTimersByTimeAsync(8_100);
    s = conns.get("p1")!.state!;
    expect(s.phase).toBe("pick");
    expect(s.round!.index).toBe(2);
    // the played clip is not offered again
    expect(s.round!.candidates.map((c) => c.id)).not.toContain(pick);

    // host can skip through the remaining rounds
    for (let i = 0; i < 20 && s.phase !== "final"; i++) {
      act("p1", { t: "skipPhase" });
      await vi.advanceTimersByTimeAsync(0);
      s = conns.get("p1")!.state!;
    }
    expect(s.phase).toBe("final");
    act("p1", { t: "playAgain" });
    s = conns.get("p1")!.state!;
    expect(s.phase).toBe("lobby");
    expect(s.players.every((p) => p.score === 0)).toBe(true);
  });

  it("marks missing takes as lost and gives them the average", async () => {
    join("p1", "Аня");
    join("p2", "Петя");
    join("p3", "Лёша");
    act("p1", { t: "settings", settings: { anonymous: false, clipPick: "host" } });
    act("p1", { t: "start" });
    await flush();
    const cand = conns.get("p1")!.state!.round!.candidates[0]!.id;
    expect(() => act("p2", { t: "pickClip", clipId: cand })).toThrow("not_host");
    act("p1", { t: "pickClip", clipId: cand });
    act("p1", {
      t: "dubUploaded",
      receipt: "r:d1:ABCDE:1:p1",
      offsetMs: 0,
      effect: "none",
      gain: 1,
    });
    act("p2", {
      t: "dubUploaded",
      receipt: "r:d2:ABCDE:1:p2",
      offsetMs: 0,
      effect: "none",
      gain: 1,
    });
    // p3 never uploads — record phase times out
    let s = conns.get("p1")!.state!;
    expect(s.phase).toBe("record");
    await vi.advanceTimersByTimeAsync(s.endsAt! - Date.now() + 10);
    s = conns.get("p1")!.state!;
    expect(s.phase).toBe("watch");
    const lost = s.round!.entries.find((e) => e.lost)!;
    expect(lost.playerIds).toEqual(["p3"]);
    await vi.advanceTimersByTimeAsync(s.endsAt! - Date.now() + 10);
    s = conns.get("p1")!.state!;
    expect(s.phase).toBe("vote");
    expect(() => act("p1", { t: "vote", entryId: lost.id })).toThrow(GameError);
    act("p1", { t: "vote", entryId: s.round!.entries.find((e) => e.playerIds[0] === "p2")!.id });
    act("p2", { t: "vote", entryId: s.round!.entries.find((e) => e.playerIds[0] === "p1")!.id });
    act("p3", { t: "vote", entryId: s.round!.entries.find((e) => e.playerIds[0] === "p1")!.id });
    s = conns.get("p1")!.state!;
    expect(s.phase).toBe("results");
    const pts = Object.fromEntries(s.players.map((p) => [p.id, p.score]));
    expect(pts).toEqual({ p1: 250, p2: 100, p3: 175 });
  });

  it("forms teams in roles mode and merges team tracks into one entry", async () => {
    room.dispose();
    room = makeRoom([clip("duo", 2), clip("duo2", 2)]);
    for (const p of ["p1", "p2", "p3", "p4"]) join(p, `Игрок ${p}`);
    act("p1", { t: "settings", settings: { mode: "roles", clipPick: "host", anonymous: false } });
    act("p1", { t: "start" });
    await flush();
    act("p1", { t: "pickClip", clipId: conns.get("p1")!.state!.round!.candidates[0]!.id });
    let s = conns.get("p1")!.state!;
    expect(s.round!.teams).toHaveLength(2);
    for (const team of s.round!.teams) {
      expect(team.flatMap((id) => s.round!.roleAssignment[id]!).sort()).toEqual(["r1", "r2"]);
    }
    for (const p of ["p1", "p2", "p3", "p4"]) {
      act(p, {
        t: "dubUploaded",
        receipt: `r:d${p}:ABCDE:1:${p}`,
        offsetMs: 0,
        effect: "none",
        gain: 1,
      });
    }
    s = conns.get("p1")!.state!;
    expect(s.round!.entries).toHaveLength(2);
    expect(s.round!.entries.every((e) => e.tracks.length === 2)).toBe(true);
  });
});

describe("long clips", () => {
  const series = {
    ...clip("series", 3),
    durationMs: 30 * 60_000,
    scenes: [
      {
        id: "s1",
        startMs: 0,
        endMs: 40_000,
        rolesCount: 2,
        roleIds: ["r2", "r3"],
        posterUrl: "/p1",
      },
      {
        id: "s2",
        startMs: 40_000,
        endMs: 90_000,
        rolesCount: 2,
        roleIds: ["r1", "r3"],
        posterUrl: "/p2",
      },
    ],
  };

  it("plays a scene per round and deals the scene's own roles", async () => {
    room.dispose();
    const tickets: { maxBytes: number }[] = [];
    room = new Room("ABCDE", {
      catalog: async () => [series],
      issueTicket: (_r, _round, pid, opts) => (tickets.push(opts), `ticket:${pid}`),
      verifyReceipt: () => null,
      rand: () => 0.1,
    });
    for (const p of ["p1", "p2"]) join(p, `Игрок ${p}`);
    act("p1", { t: "settings", settings: { mode: "roles", clipPick: "host" } });
    act("p1", { t: "start" });
    await flush();
    const cands = conns.get("p1")!.state!.round!.candidates;
    expect(cands.every((c) => c.id.startsWith("series#") && c.scene !== null)).toBe(true);
    act("p1", { t: "pickClip", clipId: cands[0]!.id });
    const s = conns.get("p1")!.state!;
    expect(s.round!.clip!.durationMs).toBeLessThanOrEqual(50_000);
    const dealt = Object.values(s.round!.roleAssignment).flat().sort();
    expect(dealt).toEqual(
      [...s.round!.clip!.scene!.roleIds, ...s.round!.clip!.scene!.roleIds].sort(),
    );
    expect(tickets[0]!.maxBytes).toBe(2 * 1024 * 1024);
  });

  it("plays the whole clip in full mode, with a bigger upload limit", async () => {
    room.dispose();
    const tickets: { maxBytes: number }[] = [];
    room = new Room("ABCDE", {
      catalog: async () => [series],
      issueTicket: (_r, _round, pid, opts) => (tickets.push(opts), `ticket:${pid}`),
      verifyReceipt: () => null,
      rand: () => 0.1,
    });
    for (const p of ["p1", "p2"]) join(p, `Игрок ${p}`);
    act("p1", { t: "settings", settings: { segment: "full", clipPick: "host" } });
    act("p1", { t: "start" });
    await flush();
    act("p1", { t: "pickClip", clipId: "series" });
    const s = conns.get("p1")!.state!;
    expect(s.round!.clip).toMatchObject({ id: "series", scene: null, durationMs: 30 * 60_000 });
    expect(tickets[0]!.maxBytes).toBeGreaterThan(6 * 1024 * 1024);
    // one attempt, no rehearsal: ~30 min + a minute of slack, not 90 min
    expect(s.endsAt! - Date.now()).toBeLessThan(32 * 60_000);
  });
});

describe("reactions", () => {
  it("are rate limited per player", async () => {
    join("p1", "Аня");
    const c2 = join("p2", "Петя");
    act("p1", { t: "settings", settings: { clipPick: "host" } });
    act("p1", { t: "start" });
    await flush();
    act("p1", { t: "pickClip", clipId: conns.get("p1")!.state!.round!.candidates[0]!.id });
    act("p1", {
      t: "dubUploaded",
      receipt: "r:d1:ABCDE:1:p1",
      offsetMs: 0,
      effect: "none",
      gain: 1,
    });
    act("p2", {
      t: "dubUploaded",
      receipt: "r:d2:ABCDE:1:p2",
      offsetMs: 0,
      effect: "none",
      gain: 1,
    });
    for (let i = 0; i < 10; i++) act("p1", { t: "reaction", emoji: "😂" });
    expect(c2.inbox.filter((m) => m.t === "reaction")).toHaveLength(3);
  });
});

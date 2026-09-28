import { describe, expect, it } from "vitest";
import {
  AVATAR_PRESETS,
  AvatarSpecSchema,
  assignTeams,
  containsProfanity,
  estimateOffset,
  generateRoomCode,
  nextHost,
  normalizeRoomCode,
  parseC2S,
  pickCandidates,
  randomAvatar,
  resolvePick,
  sanitizeName,
  scoreRound,
  uniquifyName,
  ROOM_CODE_ALPHABET,
  type CatalogEntry,
  type Entry,
  type PlayerPublic,
} from "./index.ts";
import {
  dubBelongsTo,
  issueGuestToken,
  issueUploadTicket,
  sign,
  verify,
  verifyGuestToken,
  verifyUploadTicket,
} from "./token.ts";

const clip = (
  id: string,
  rolesCount = 1,
  ageRating: "0+" | "12+" | "16+" = "0+",
): CatalogEntry => ({
  id,
  slug: id,
  version: 1,
  title: { ru: id },
  durationMs: 20000,
  rolesCount,
  ageRating,
  tags: [],
  credit: "",
  manifestUrl: `/media/clips/${id}/v1/manifest.json`,
  posterUrl: "",
  previewUrl: null,
});

const entry = (id: string, playerIds: string[], lost = false): Entry => ({
  id,
  playerIds,
  tracks: [],
  lost,
});

describe("room codes", () => {
  it("uses 5 chars without look-alikes", () => {
    let i = 0;
    const code = generateRoomCode((max) => i++ % max);
    expect(code).toHaveLength(5);
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[01OIL]/);
  });
  it("normalizes user input", () => {
    expect(normalizeRoomCode(" k7qx2 ")).toBe("K7QX2");
    expect(normalizeRoomCode("K0QX2")).toBeNull();
    expect(normalizeRoomCode("AB")).toBeNull();
  });
});

describe("names", () => {
  it("validates length and trims", () => {
    expect(sanitizeName("  Аня  ")).toEqual({ ok: true, name: "Аня" });
    expect(sanitizeName("A")).toEqual({ ok: false, error: "length" });
    expect(sanitizeName("x".repeat(21))).toEqual({ ok: false, error: "length" });
  });
  it("filters profanity including obfuscations", () => {
    expect(containsProfanity("сука")).toBe(true);
    expect(containsProfanity("cyka")).toBe(true);
    expect(containsProfanity("F.u.c.k")).toBe(true);
    expect(containsProfanity("Капитан Дубляж")).toBe(false);
    expect(containsProfanity("Mike")).toBe(false);
  });
  it("uniquifies within a room", () => {
    expect(uniquifyName("Аня", ["Петя"])).toBe("Аня");
    expect(uniquifyName("Аня", ["аня"])).toBe("Аня 2");
    expect(uniquifyName("Аня", ["Аня", "Аня 2"])).toBe("Аня 3");
    expect([...uniquifyName("x".repeat(20), ["x".repeat(20)])]).toHaveLength(20);
  });
});

describe("avatars", () => {
  it("presets and random avatars are valid and small", () => {
    expect(AVATAR_PRESETS).toHaveLength(24);
    for (const a of [...AVATAR_PRESETS, randomAvatar()]) {
      expect(AvatarSpecSchema.safeParse(a).success).toBe(true);
      expect(JSON.stringify(a).length).toBeLessThan(100);
    }
  });
});

describe("scoring", () => {
  it("awards 100 per vote plus winner bonus and ignores self votes", () => {
    const entries = [entry("e1", ["a"]), entry("e2", ["b"]), entry("e3", ["c"])];
    const res = scoreRound(entries, [
      { voterId: "a", entryId: "e2", spectator: false },
      { voterId: "c", entryId: "e2", spectator: false },
      { voterId: "b", entryId: "e1", spectator: false },
      { voterId: "b", entryId: "e2", spectator: false }, // self vote — ignored
    ]);
    const by = Object.fromEntries(res.map((r) => [r.entryId, r]));
    expect(by.e2).toMatchObject({ votes: 2, points: 250, winner: true });
    expect(by.e1).toMatchObject({ votes: 1, points: 100, winner: false });
    expect(by.e3).toMatchObject({ votes: 0, points: 0 });
  });
  it("weights spectators and gives the audience award", () => {
    const entries = [entry("e1", ["a"]), entry("e2", ["b"])];
    const res = scoreRound(entries, [
      { voterId: "a", entryId: "e2", spectator: false },
      { voterId: "s1", entryId: "e1", spectator: true },
      { voterId: "s2", entryId: "e1", spectator: true },
      { voterId: "s3", entryId: "e1", spectator: true },
    ]);
    const by = Object.fromEntries(res.map((r) => [r.entryId, r]));
    // e1: 3 × 0.5 = 1.5 votes → 150 + winner 50 + audience 25
    expect(by.e1).toMatchObject({ points: 225, winner: true, audienceAward: true });
    expect(by.e2).toMatchObject({ points: 100, winner: false });
  });
  it("gives lost takes the average instead of zero", () => {
    const entries = [entry("e1", ["a"]), entry("e2", ["b"]), entry("e3", ["c"], true)];
    const res = scoreRound(entries, [
      { voterId: "a", entryId: "e2", spectator: false },
      { voterId: "b", entryId: "e1", spectator: false },
      { voterId: "c", entryId: "e1", spectator: false },
    ]);
    const by = Object.fromEntries(res.map((r) => [r.entryId, r]));
    expect(by.e1!.points).toBe(250);
    expect(by.e2!.points).toBe(100);
    expect(by.e3!.points).toBe(175);
  });
  it("no votes → no winner", () => {
    const res = scoreRound([entry("e1", ["a"]), entry("e2", ["b"])], []);
    expect(res.every((r) => !r.winner && r.points === 0)).toBe(true);
  });
});

describe("teams (roles mode)", () => {
  it("makes at least two teams and deals every role inside each team", () => {
    const { teams, assignment } = assignTeams(["a", "b"], ["r1", "r2"]);
    expect(teams).toEqual([["a"], ["b"]]);
    expect(assignment).toEqual({ a: ["r1", "r2"], b: ["r1", "r2"] });
  });
  it("keeps team size ≤ role count", () => {
    const { teams, assignment } = assignTeams(["a", "b", "c", "d", "e"], ["r1", "r2"]);
    expect(teams.length).toBe(3);
    expect(Math.max(...teams.map((t) => t.length))).toBeLessThanOrEqual(2);
    for (const team of teams) {
      const roles = team.flatMap((p) => assignment[p]!).sort();
      expect(roles).toEqual(["r1", "r2"]);
    }
  });
});

describe("clip picking", () => {
  const catalog = [clip("a"), clip("b", 2), clip("c", 3, "16+"), clip("d")];
  it("filters by age rating and prefers multi-role clips in roles mode", () => {
    const c = pickCandidates(catalog, { mode: "roles", maxAgeRating: "12+" }, new Set(), 3);
    expect(c.map((x) => x.id)).toEqual(["b"]);
    const all = pickCandidates(catalog, { mode: "classic", maxAgeRating: "12+" }, new Set(), 3);
    expect(all.map((x) => x.id).sort()).toEqual(["a", "b", "d"]);
  });
  it("avoids already played clips while possible", () => {
    const c = pickCandidates(catalog, { mode: "classic", maxAgeRating: "0+" }, new Set(["a"]), 3);
    expect(c.map((x) => x.id).sort()).toEqual(["b", "d"]);
  });
  it("resolves the majority vote", () => {
    const cands = [clip("a"), clip("b"), clip("c")];
    expect(resolvePick(cands, { p1: "b", p2: "b", p3: "a" })?.id).toBe("b");
    expect(resolvePick([], {})).toBeNull();
  });
});

describe("host migration", () => {
  const p = (id: string, joinedAt: number, connected = true, spectator = false): PlayerPublic => ({
    id,
    name: id,
    avatar: randomAvatar(),
    spectator,
    connected,
    isHost: false,
    score: 0,
    status: "idle",
    progress: 0,
    joinedAt,
  });
  it("passes to the next connected player by join time", () => {
    expect(nextHost([p("a", 3), p("b", 1, false), p("c", 2)])).toBe("c");
    expect(nextHost([p("s", 1, true, true), p("b", 2, false)])).toBe("s");
    expect(nextHost([])).toBeNull();
  });
});

describe("clock sync", () => {
  it("estimates offset from low-RTT samples", () => {
    const r = estimateOffset([
      { clientSent: 0, clientReceived: 100, serverNow: 1050 }, // rtt 100, offset 1000
      { clientSent: 200, clientReceived: 240, serverNow: 1220 }, // rtt 40, offset 1000
      { clientSent: 300, clientReceived: 900, serverNow: 1900 }, // noisy
    ]);
    expect(r?.offset).toBe(1000);
  });
});

describe("protocol", () => {
  it("accepts valid and rejects malformed messages", () => {
    expect(parseC2S({ t: "vote", entryId: "e1" })).toEqual({ t: "vote", entryId: "e1" });
    expect(parseC2S({ t: "vote" })).toBeNull();
    expect(parseC2S({ t: "reaction", emoji: "💩" })).toBeNull();
    expect(parseC2S({ t: "hack" })).toBeNull();
  });
});

describe("tokens", () => {
  const key = "k".repeat(32);
  it("signs and verifies, rejects tampering and expiry", () => {
    const t = sign({ a: 1, exp: Date.now() + 1000 }, key);
    expect(verify(t, [key])).toMatchObject({ a: 1 });
    expect(
      verify(
        t.replace(/.$/, (c) => (c === "A" ? "B" : "A")),
        [key],
      ),
    ).toBeNull();
    expect(verify(t, ["other"])).toBeNull();
    expect(verify(sign({ exp: 1 }, key), [key])).toBeNull();
  });
  it("supports key rotation", () => {
    const { token } = issueGuestToken("p1", "secret", "old");
    expect(verifyGuestToken(token, ["new", "old"])?.sub).toBe("p1");
  });
  it("upload tickets are not guest tokens", () => {
    const { ticket } = issueUploadTicket("ABCDE", 2, "p1", key);
    expect(verifyUploadTicket(ticket, [key])).toMatchObject({ room: "ABCDE", round: 2, sub: "p1" });
    expect(verifyGuestToken(ticket, [key])).toBeNull();
    expect(dubBelongsTo("ABCDE.2.p1.xyz", "ABCDE", 2, "p1")).toBe(true);
    expect(dubBelongsTo("ABCDE.2.p10.xyz", "ABCDE", 2, "p1")).toBe(false);
  });
});

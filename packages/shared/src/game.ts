import { z } from "zod";
import type { AvatarSpec } from "./avatar.ts";
import type { Playable } from "./catalog.ts";

export const MAX_PLAYERS = 6;
export const MAX_SPECTATORS = 20;
export const RECONNECT_GRACE_MS = 60_000;

export const AGE_RATINGS = ["0+", "12+", "16+"] as const;
export type AgeRating = (typeof AGE_RATINGS)[number];

export function ageRatingAllowed(clip: AgeRating, max: AgeRating): boolean {
  return AGE_RATINGS.indexOf(clip) <= AGE_RATINGS.indexOf(max);
}

export const GAME_MODES = ["classic", "roles", "improv"] as const;
export type GameMode = (typeof GAME_MODES)[number];

export const EFFECTS = ["none", "robot", "bass", "echo", "radio", "chipmunk"] as const;
export type EffectId = (typeof EFFECTS)[number];

export const REACTIONS = ["😂", "👏", "🔥", "🤯", "😱", "❤️"] as const;

export const RoomSettingsSchema = z.object({
  rounds: z.union([z.literal(3), z.literal(5), z.literal(7)]),
  mode: z.enum(GAME_MODES),
  maxAgeRating: z.enum(AGE_RATINGS),
  anonymous: z.boolean(),
  /** "vote": players vote for one of 3 candidates; "host": host picks. */
  clipPick: z.enum(["vote", "host"]),
  /** Accessibility: "no timers" mode multiplies all timers by 3 (§15). */
  relaxedTimers: z.boolean(),
  /** FR-1: reject new joins while a game is running (spectators still allowed). */
  locked: z.boolean(),
  /** long clips: play one scene per round, or the whole clip */
  segment: z.enum(["scene", "full"]),
});
export type RoomSettings = z.infer<typeof RoomSettingsSchema>;

export const DEFAULT_SETTINGS: RoomSettings = {
  rounds: 5,
  mode: "classic",
  maxAgeRating: "12+",
  anonymous: true,
  clipPick: "vote",
  relaxedTimers: false,
  locked: false,
  segment: "scene",
};

export type Phase =
  | "lobby"
  | "pick" // choose a clip
  | "record" // rehearse + record + upload, locally paced per player
  | "watch" // synchronized playback of every dub
  | "vote"
  | "results"
  | "final";

/** Default phase durations in ms (§3.1). */
export const PHASE_MS = {
  pick: 20_000,
  vote: 20_000,
  results: 8_000,
  /** gap between two dubs during watch */
  watchGap: 2_500,
  /** how long clients get to load media before the record phase clock matters */
  load: 10_000,
  /** countdown before recording */
  countdown: 3_000,
  /** time to listen back, pick effect, adjust sync and upload */
  review: 30_000,
} as const;

/** Longer takes get one attempt and no rehearsal — otherwise a round never ends. */
export const LONG_TAKE_MS = 180_000;
/** Above this, clients stream media instead of preloading and decoding it into memory. */
export const STREAM_THRESHOLD_MS = 120_000;

export function maxAttempts(clipMs: number): number {
  return clipMs > LONG_TAKE_MS ? 1 : 2;
}

export function rehearsalAllowed(clipMs: number): boolean {
  return clipMs <= LONG_TAKE_MS;
}

/** Record phase = load + rehearsal + attempts × (countdown + clip) + review. */
export function recordPhaseMs(clipMs: number, relaxed: boolean): number {
  const rehearsal = rehearsalAllowed(clipMs) ? clipMs : 0;
  const base =
    PHASE_MS.load +
    rehearsal +
    maxAttempts(clipMs) * (PHASE_MS.countdown + clipMs) +
    PHASE_MS.review;
  return relaxed ? base * 3 : base;
}

/** Recording bitrate: long takes use less so they stay small (Opus voice is fine at 32 kbit/s). */
export function recordingBitrate(clipMs: number): number {
  return clipMs > STREAM_THRESHOLD_MS ? 32_000 : 48_000;
}

/** Upload cap for a take of a clip of this length (§14: 2 MB for normal clips). */
export function maxDubBytes(clipMs: number): number {
  const seconds = (clipMs + PHASE_MS.countdown + 5_000) / 1000;
  const estimate = Math.ceil(seconds * (recordingBitrate(clipMs) / 8) * 1.5);
  return Math.max(2 * 1024 * 1024, estimate);
}

export function timerMs(ms: number, relaxed: boolean): number {
  return relaxed ? ms * 3 : ms;
}

export type PlayerStatus = "idle" | "loading" | "ready" | "recording" | "uploading" | "done";

export interface PlayerPublic {
  id: string;
  name: string;
  avatar: AvatarSpec;
  spectator: boolean;
  connected: boolean;
  isHost: boolean;
  score: number;
  status: PlayerStatus;
  /** Upload progress 0..1 while status === "uploading". */
  progress: number;
  joinedAt: number;
}

export interface DubTrack {
  /** empty string while the room is anonymous and results are not revealed yet */
  playerId: string;
  dubId: string;
  offsetMs: number;
  effect: EffectId;
  /** linear gain that brings the take to a common loudness (§13) */
  gain: number;
  /** roles voiced in this track (roles mode) */
  roles: string[];
}

/** One thing to watch and vote for: a single player's dub (classic) or a team (roles). */
export interface Entry {
  id: string;
  /** players credited for this entry (empty while anonymous and not yet revealed) */
  playerIds: string[];
  tracks: DubTrack[];
  /** true when no take of this entry arrived ("the recording got lost on the way", §13) */
  lost: boolean;
}

export interface RoundResult {
  entryId: string;
  votes: number;
  spectatorVotes: number;
  points: number;
  winner: boolean;
  audienceAward: boolean;
}

export interface RoundState {
  index: number; // 1-based
  /** players taking part in this round (non-spectators at round start) */
  participants: string[];
  candidates: Playable[];
  /** playerId → clipId */
  pickVotes: Record<string, string>;
  clip: Playable | null;
  /** roles mode: playerId → roleIds */
  roleAssignment: Record<string, string[]>;
  /** roles mode: team index per player */
  teams: string[][];
  entries: Entry[];
  /** index into entries currently playing during "watch" */
  watching: number;
  /** filled when the vote phase ends */
  results: RoundResult[] | null;
  /** number of votes cast so far (who voted for what stays secret until results) */
  votesCast: number;
  /** personalized: the viewer's own entry (can't vote for it) */
  myEntryId: string | null;
}

export interface RoomSnapshot {
  code: string;
  settings: RoomSettings;
  phase: Phase;
  /** server time (ms) when the current phase ends; null = no timer */
  endsAt: number | null;
  players: PlayerPublic[];
  round: RoundState | null;
  /** best entry of the whole game, for "rewatch" on the final screen */
  bestOfGame: { round: number; clip: Playable; entry: Entry; votes: number } | null;
}

/* ---------- pure game rules (unit-tested) ---------- */

export const POINTS = { perVote: 100, winnerBonus: 50, audienceBonus: 25 } as const;
export const SPECTATOR_VOTE_WEIGHT = 0.5;

export interface VoteInput {
  voterId: string;
  entryId: string;
  spectator: boolean;
}

/**
 * Scores one round (§3.3). Votes for one's own entry are ignored. Entries whose take was lost get
 * the average points of the other entries instead of zero (§13).
 */
export function scoreRound(entries: Entry[], votes: VoteInput[]): RoundResult[] {
  const byEntry = new Map(entries.map((e) => [e.id, e]));
  const tally = new Map<string, { votes: number; spectatorVotes: number }>();
  for (const e of entries) tally.set(e.id, { votes: 0, spectatorVotes: 0 });

  for (const v of votes) {
    const entry = byEntry.get(v.entryId);
    if (!entry || entry.lost) continue;
    if (entry.playerIds.includes(v.voterId)) continue;
    const t = tally.get(entry.id)!;
    if (v.spectator) t.spectatorVotes++;
    else t.votes++;
  }

  const weighted = (id: string) => {
    const t = tally.get(id)!;
    return t.votes + t.spectatorVotes * SPECTATOR_VOTE_WEIGHT;
  };

  const eligible = entries.filter((e) => !e.lost);
  const maxScore = Math.max(0, ...eligible.map((e) => weighted(e.id)));
  const maxSpectator = Math.max(0, ...eligible.map((e) => tally.get(e.id)!.spectatorVotes));

  const results: RoundResult[] = entries.map((e) => {
    const t = tally.get(e.id)!;
    const w = weighted(e.id);
    const winner = !e.lost && maxScore > 0 && w === maxScore;
    const audienceAward = !e.lost && maxSpectator > 0 && t.spectatorVotes === maxSpectator;
    let points = Math.round(w * POINTS.perVote);
    if (winner) points += POINTS.winnerBonus;
    if (audienceAward) points += POINTS.audienceBonus;
    return {
      entryId: e.id,
      votes: t.votes,
      spectatorVotes: t.spectatorVotes,
      points,
      winner,
      audienceAward,
    };
  });

  const scored = results.filter((r) => !byEntry.get(r.entryId)!.lost);
  const avg = scored.length ? scored.reduce((s, r) => s + r.points, 0) / scored.length : 0;
  for (const r of results) if (byEntry.get(r.entryId)!.lost) r.points = Math.round(avg);
  return results;
}

/**
 * Roles mode (§3.2): split players into teams no larger than the clip's role count, with at least
 * two teams so there is something to vote on. Inside a team, roles are dealt round-robin, so a
 * solo player voices every role.
 */
export function assignTeams(
  playerIds: string[],
  roleIds: string[],
): { teams: string[][]; assignment: Record<string, string[]> } {
  const roles = roleIds.length ? roleIds : ["r1"];
  const teamCount = Math.max(2, Math.ceil(playerIds.length / roles.length));
  const teams: string[][] = Array.from({ length: Math.min(teamCount, playerIds.length) }, () => []);
  playerIds.forEach((id, i) => teams[i % teams.length]!.push(id));
  const assignment: Record<string, string[]> = {};
  for (const team of teams) {
    team.forEach((id) => (assignment[id] = []));
    roles.forEach((role, i) => assignment[team[i % team.length]!]!.push(role));
  }
  return { teams, assignment };
}

/**
 * Picks up to `n` random candidates, preferring ones that fit the mode and rating, haven't been
 * played, and come from different clips (so three scenes of one series don't crowd the choice).
 */
export function pickCandidates(
  playables: Playable[],
  settings: Pick<RoomSettings, "mode" | "maxAgeRating">,
  exclude: Set<string>,
  n: number,
  rand: () => number = Math.random,
): Playable[] {
  const allowed = playables.filter((c) => ageRatingAllowed(c.ageRating, settings.maxAgeRating));
  const byMode = settings.mode === "roles" ? allowed.filter((c) => c.rolesCount >= 2) : allowed;
  const pools = [
    byMode.filter((c) => !exclude.has(c.id)),
    byMode,
    allowed.filter((c) => !exclude.has(c.id)),
    allowed,
  ];
  const pool = pools.find((p) => p.length > 0) ?? [];
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const picked: Playable[] = [];
  const clips = new Set<string>();
  for (const c of shuffled) {
    if (picked.length < n && !clips.has(c.clipId)) {
      picked.push(c);
      clips.add(c.clipId);
    }
  }
  for (const c of shuffled) if (picked.length < n && !picked.includes(c)) picked.push(c);
  return picked;
}

/** Majority of pick votes; ties and "no votes" are resolved randomly. */
export function resolvePick(
  candidates: Playable[],
  votes: Record<string, string>,
  rand: () => number = Math.random,
): Playable | null {
  if (candidates.length === 0) return null;
  const counts = new Map<string, number>(candidates.map((c) => [c.id, 0]));
  for (const clipId of Object.values(votes)) {
    if (counts.has(clipId)) counts.set(clipId, counts.get(clipId)! + 1);
  }
  const max = Math.max(...counts.values());
  const top = candidates.filter((c) => counts.get(c.id) === max);
  return top[Math.floor(rand() * top.length)] ?? null;
}

/** Host migration (US-2): the earliest-joined connected non-spectator, else any connected. */
export function nextHost(players: PlayerPublic[]): string | null {
  const byJoin = [...players].sort((a, b) => a.joinedAt - b.joinedAt);
  return (
    byJoin.find((p) => p.connected && !p.spectator)?.id ??
    byJoin.find((p) => p.connected)?.id ??
    null
  );
}

/** Loudness normalization gain from a take's RMS (linear), clamped to a sane range. */
export function normalizeGain(rms: number, targetRms = 0.1): number {
  if (!(rms > 0)) return 1;
  return Math.min(4, Math.max(0.25, targetRms / rms));
}

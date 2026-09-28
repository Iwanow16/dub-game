import { z } from "zod";
import { AvatarSpecSchema } from "./avatar.ts";
import { EFFECTS, REACTIONS, RoomSettingsSchema, type Phase, type RoomSnapshot } from "./game.ts";

/** WebSocket limits (§22.10). */
export const WS_MAX_MESSAGE_BYTES = 16 * 1024;
export const WS_MAX_MESSAGES_PER_SEC = 20;
export const WS_PING_INTERVAL_MS = 20_000;

const id = z.string().min(1).max(64);

/** client → server (§6.4) */
export const C2SSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("join"),
    roomCode: z.string().min(4).max(6),
    token: z.string().min(10).max(1024),
    name: z.string().max(64),
    avatar: AvatarSpecSchema,
    spectator: z.boolean().optional(),
  }),
  z.object({ t: z.literal("leave") }),
  z.object({ t: z.literal("ping"), clientNow: z.number() }),
  z.object({ t: z.literal("settings"), settings: RoomSettingsSchema.partial() }),
  z.object({ t: z.literal("start") }),
  z.object({ t: z.literal("kick"), playerId: id }),
  z.object({ t: z.literal("rename"), playerId: id, name: z.string().max(64) }),
  z.object({ t: z.literal("becomeSpectator"), spectator: z.boolean() }),
  z.object({ t: z.literal("pickClip"), clipId: id }),
  /** media for the chosen clip is buffered */
  z.object({ t: z.literal("ready") }),
  z.object({
    t: z.literal("status"),
    status: z.enum(["recording", "uploading"]),
    progress: z.number().min(0).max(1).optional(),
  }),
  z.object({
    t: z.literal("dubUploaded"),
    receipt: z.string().min(10).max(1024),
    offsetMs: z.number().min(-5000).max(5000),
    effect: z.enum(EFFECTS),
    gain: z.number().min(0.1).max(10),
  }),
  z.object({ t: z.literal("vote"), entryId: id }),
  z.object({ t: z.literal("reaction"), emoji: z.enum(REACTIONS) }),
  z.object({ t: z.literal("playAgain") }),
  z.object({ t: z.literal("skipPhase") }),
]);
export type C2S = z.infer<typeof C2SSchema>;

export type ErrorCode =
  | "bad_message"
  | "rate_limited"
  | "room_not_found"
  | "room_full"
  | "room_locked"
  | "bad_token"
  | "bad_name"
  | "not_host"
  | "wrong_phase"
  | "not_allowed"
  | "kicked"
  | "too_many_connections";

/** server → client */
export type S2C =
  | { t: "welcome"; playerId: string; room: RoomSnapshot; v: number; serverNow: number }
  | { t: "state"; room: RoomSnapshot; v: number }
  | { t: "phase"; phase: Phase; endsAt: number | null }
  | { t: "playAt"; entryId: string; index: number; startAt: number }
  | { t: "pong"; clientNow: number; serverNow: number }
  | { t: "uploadTicket"; ticket: string; round: number; expiresAt: number }
  | { t: "reaction"; playerId: string; emoji: string }
  | { t: "myVote"; entryId: string | null }
  | { t: "error"; code: ErrorCode; message?: string };

export function parseC2S(raw: unknown): C2S | null {
  const r = C2SSchema.safeParse(raw);
  return r.success ? r.data : null;
}

import { create } from "zustand";
import type { ErrorCode, RoomSnapshot } from "@dubroom/shared";

export type ConnState = "idle" | "connecting" | "online" | "reconnecting" | "offline";

export interface GameState {
  conn: ConnState;
  /** when reconnecting gives up (client ms) */
  reconnectDeadline: number | null;
  room: RoomSnapshot | null;
  me: string | null;
  /** serverNow − clientNow, ms */
  serverOffset: number;
  rtt: number | null;
  ticket: { ticket: string; round: number; expiresAt: number } | null;
  myVote: string | null;
  playAt: { entryId: string; index: number; startAt: number } | null;
  reactions: { id: number; emoji: string; x: number; playerId: string }[];
  /** fatal error that ends the session (kicked, not found, …) */
  fatal: ErrorCode | null;
  lastError: { code: ErrorCode; message?: string; at: number } | null;
}

export const initialGameState: GameState = {
  conn: "idle",
  reconnectDeadline: null,
  room: null,
  me: null,
  serverOffset: 0,
  rtt: null,
  ticket: null,
  myVote: null,
  playAt: null,
  reactions: [],
  fatal: null,
  lastError: null,
};

export const useGame = create<GameState>(() => ({ ...initialGameState }));

/** Server time now, in ms. */
export const serverNow = () => Date.now() + useGame.getState().serverOffset;

export function selectMe(s: GameState) {
  return s.room?.players.find((p) => p.id === s.me) ?? null;
}

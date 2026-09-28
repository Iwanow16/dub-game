import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal signed tokens (HMAC-SHA256, JWT-like "payload.signature" in base64url).
 * Server-only: imported via "@dubroom/shared/token".
 *
 * Several signing keys may be active at once so rotation (§22.8) keeps old tokens valid for a
 * grace period: sign with keys[0], verify against every key.
 */
function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function sign(payload: object, key: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac("sha256", key).update(body).digest());
  return `${body}.${sig}`;
}

export function verify<T extends { exp: number }>(
  token: string,
  keys: string[],
  now = Date.now(),
): T | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1), "base64url");
  const valid = keys.some((key) => {
    const expected = createHmac("sha256", key).update(body).digest();
    return expected.length === sig.length && timingSafeEqual(expected, sig);
  });
  if (!valid) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    if (typeof payload.exp !== "number" || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseKeys(env: string | undefined): string[] {
  const keys = (env ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (keys.length === 0) throw new Error("TOKEN_SIGNING_KEY is not set");
  return keys;
}

/* ---------- guest identity (§5.1) ---------- */

export const GUEST_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

export interface GuestToken {
  typ: "guest";
  /** playerId */
  sub: string;
  /** sha256(playerSecret) — lets the holder of the secret re-issue the token */
  sh: string;
  exp: number;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

export function issueGuestToken(playerId: string, secret: string, key: string, now = Date.now()) {
  const payload: GuestToken = {
    typ: "guest",
    sub: playerId,
    sh: hashSecret(secret),
    exp: now + GUEST_TOKEN_TTL_MS,
  };
  return { token: sign(payload, key), expiresAt: payload.exp };
}

export function verifyGuestToken(token: string, keys: string[], now = Date.now()) {
  const p = verify<GuestToken>(token, keys, now);
  return p && p.typ === "guest" ? p : null;
}

/* ---------- dub upload tickets (presigned-URL equivalent, §11.6/§14) ---------- */

export const UPLOAD_TICKET_TTL_MS = 10 * 60 * 1000;

export interface UploadTicket {
  typ: "upload";
  room: string;
  round: number;
  sub: string;
  exp: number;
}

export function issueUploadTicket(
  room: string,
  round: number,
  playerId: string,
  key: string,
  ttlMs = UPLOAD_TICKET_TTL_MS,
  now = Date.now(),
) {
  const payload: UploadTicket = { typ: "upload", room, round, sub: playerId, exp: now + ttlMs };
  return { ticket: sign(payload, key), expiresAt: payload.exp };
}

export function verifyUploadTicket(ticket: string, keys: string[], now = Date.now()) {
  const p = verify<UploadTicket>(ticket, keys, now);
  return p && p.typ === "upload" ? p : null;
}

/** dubId layout: `<room>.<round>.<playerId>.<random>` — lets the game server check ownership. */
export function dubBelongsTo(dubId: string, room: string, round: number, playerId: string) {
  return dubId.startsWith(`${room}.${round}.${playerId}.`);
}

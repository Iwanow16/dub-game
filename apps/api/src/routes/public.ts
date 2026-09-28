import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  hashSecret,
  issueGuestToken,
  verifyGuestToken,
  verifyUploadTicket,
} from "@dubroom/shared/token";

const GuestBody = z.object({
  playerId: z.string().uuid(),
  playerSecret: z.string().min(32).max(128),
});

const ReportBody = z.object({
  targetType: z.enum(["clip", "player", "dub"]),
  targetId: z.string().min(1).max(128),
  reason: z.string().min(1).max(500),
});

export const DUB_ID_RE = /^[A-Z0-9]{4,6}\.\d{1,2}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{12}$/;

/** Detects the container from magic bytes — the Content-Type header is not trusted (§14). */
export function sniffAudio(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length < 12) return null;
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return { mime: "audio/webm", ext: "webm" };
  if (buf.toString("ascii", 0, 4) === "OggS") return { mime: "audio/ogg", ext: "ogg" };
  if (buf.toString("ascii", 4, 8) === "ftyp") return { mime: "audio/mp4", ext: "m4a" };
  return null;
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

export async function publicRoutes(app: FastifyInstance) {
  const { config, db, catalog } = app.deps;

  app.get("/api/health", async () => ({
    ok: true,
    service: "api",
    version: process.env.APP_VERSION ?? "dev",
  }));

  /** Guest identity (§5.1): first call registers playerId+secret, later calls re-issue the token. */
  app.post(
    "/api/guest",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = GuestBody.safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: "bad_request" });
      const { playerId, playerSecret } = body.data;
      const hash = hashSecret(playerSecret);
      const existing = db.getGuest(playerId);
      if (existing && existing.secretHash !== hash)
        return reply.status(403).send({ error: "secret_mismatch" });
      db.upsertGuest(playerId, hash);
      const { token, expiresAt } = issueGuestToken(playerId, playerSecret, config.signingKeys[0]!);
      return { playerId, token, expiresAt };
    },
  );

  app.get("/api/catalog", async (req, reply) => {
    const { body, etag } = catalog.get();
    reply.header("cache-control", "public, max-age=60, stale-while-revalidate=600");
    reply.header("etag", etag);
    if (req.headers["if-none-match"] === etag) return reply.status(304).send();
    reply.type("application/json").send(body);
  });

  /**
   * Dub upload (§11.6): authorized by a short-lived upload ticket that the game server hands to
   * room members during the record phase — the equivalent of a presigned URL.
   */
  app.post(
    "/api/dubs",
    {
      bodyLimit: config.dubMaxBytes,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const ticketRaw = req.headers["x-upload-ticket"];
      const ticket =
        typeof ticketRaw === "string" ? verifyUploadTicket(ticketRaw, config.signingKeys) : null;
      if (!ticket) return reply.status(401).send({ error: "bad_ticket" });
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0)
        return reply.status(400).send({ error: "empty" });
      if (body.length > config.dubMaxBytes) return reply.status(413).send({ error: "too_large" });
      const kind = sniffAudio(body);
      if (!kind) return reply.status(415).send({ error: "unsupported_media" });

      const dubId = `${ticket.room}.${ticket.round}.${ticket.sub}.${randomBytes(9).toString("base64url")}`;
      const rel = join("dubs", ticket.room, String(ticket.round), `${dubId}.${kind.ext}`);
      await mkdir(join(config.dataDir, "dubs", ticket.room, String(ticket.round)), {
        recursive: true,
      });
      await writeFile(join(config.dataDir, rel), body);
      db.insertDub({
        id: dubId,
        room: ticket.room,
        round: ticket.round,
        playerId: ticket.sub,
        path: rel,
        mime: kind.mime,
        bytes: body.length,
        ttlMs: config.dubTtlMs,
      });
      return { dubId };
    },
  );

  /** Dubs are only reachable by their unguessable id, which only room members receive. */
  app.get<{ Params: { id: string } }>("/media/dubs/:id", async (req, reply) => {
    const id = req.params.id;
    if (!DUB_ID_RE.test(id)) return reply.status(404).send({ error: "not_found" });
    const dub = db.getDub(id);
    if (!dub || dub.expiresAt < Date.now()) return reply.status(404).send({ error: "not_found" });
    const file = join(config.dataDir, dub.path);
    const size = (await stat(file)).size;
    reply.header("cache-control", "private, max-age=86400, immutable");
    reply.header("content-length", size);
    reply.type(dub.mime);
    return reply.send(createReadStream(file));
  });

  app.post(
    "/api/reports",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const token = bearer(req);
      const guest = token ? verifyGuestToken(token, config.signingKeys) : null;
      if (!guest) return reply.status(401).send({ error: "bad_token" });
      const body = ReportBody.safeParse(req.body);
      if (!body.success) return reply.status(400).send({ error: "bad_request" });
      db.insertReport({ id: randomUUID(), reporterId: guest.sub, ...body.data });
      return { ok: true };
    },
  );
}

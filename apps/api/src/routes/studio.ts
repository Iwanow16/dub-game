import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, rm, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { validateManifest, type ClipManifest } from "@dubroom/clip-format";
import { DbError, type SourceKind } from "@dubroom/db";
import { sign, verify } from "@dubroom/shared/token";

const KINDS: SourceKind[] = ["video", "bed", "dialogue"];
/** Max source size (§9.2): 2 GB, uploaded in ≤ 50 MB chunks. */
const MAX_SOURCE_BYTES = 2 * 1024 ** 3;
const MAX_CHUNK_BYTES = 50 * 1024 * 1024 + 1024;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function draftDir(dataDir: string, draftId: string) {
  return join(dataDir, "uploads", draftId);
}

/**
 * Clip Studio API (§9). Access requires the shared STUDIO_KEY and — in production — the Studio
 * hostname and a valid Cloudflare Access JWT (§22.9, §22.10).
 */
export async function studioRoutes(app: FastifyInstance) {
  const { config, db, catalog } = app.deps;
  const limits = { maxDurationMs: config.clipMaxMs };
  const jwks = config.cfAccess
    ? createRemoteJWKSet(new URL(`https://${config.cfAccess.teamDomain}/cdn-cgi/access/certs`))
    : null;

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (config.studioHost && req.hostname !== config.studioHost) {
      return reply.status(404).send({ error: "not_found" });
    }
    // <video>/<audio> can't send headers: media of a draft may be fetched with a short-lived
    // signed link instead (GET /drafts/:id/media-link), still behind Cloudflare Access
    const mediaLink = /^\/api\/studio\/drafts\/([\w-]+)\/source\/(proxy|peaks)\?t=([\w.-]+)$/.exec(
      req.url,
    );
    let linkOk = false;
    if (mediaLink) {
      const t = verify<{ typ: string; draft: string; exp: number }>(
        mediaLink[3]!,
        config.signingKeys,
      );
      linkOk = t?.typ === "studio-media" && t.draft === mediaLink[1];
    }
    const auth = req.headers.authorization ?? "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!linkOk && (!key || !safeEqual(key, config.studioKey))) {
      return reply.status(401).send({ error: "unauthorized" });
    }
    if (jwks && config.cfAccess) {
      const assertion = req.headers["cf-access-jwt-assertion"];
      if (typeof assertion !== "string")
        return reply.status(401).send({ error: "access_required" });
      try {
        const { payload } = await jwtVerify(assertion, jwks, {
          issuer: `https://${config.cfAccess.teamDomain}`,
          audience: config.cfAccess.aud,
        });
        (req as FastifyRequest & { author?: string }).author = String(payload.email ?? "");
      } catch {
        return reply.status(401).send({ error: "access_invalid" });
      }
    }
  });

  const author = (req: FastifyRequest) =>
    (req as FastifyRequest & { author?: string }).author ?? "studio";

  const handleDbError = (reply: FastifyReply, e: unknown) => {
    if (e instanceof DbError) {
      const status = e.code === "not_found" ? 404 : 409;
      return reply.status(status).send({ error: e.code, message: e.message });
    }
    throw e;
  };

  app.get("/me", async (req) => ({ ok: true, author: author(req) }));

  app.get("/clips", async () => ({ clips: db.listClips() }));

  app.get("/drafts", async () => ({ drafts: db.listDrafts() }));

  app.post("/drafts", async (req, reply) => {
    const body = z.object({ manifest: z.unknown() }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: "bad_request" });
    // structural check only — content checks run on submit
    const v = validateManifest(body.data.manifest, limits);
    const schemaErrors = v.errors.filter((e) => e.code === "schema");
    if (schemaErrors.length)
      return reply.status(400).send({ error: "invalid_manifest", issues: schemaErrors });
    try {
      const draft = db.createDraft(randomUUID(), v.manifest!, author(req));
      await mkdir(draftDir(config.dataDir, draft.id), { recursive: true });
      return { draftId: draft.id, draft };
    } catch (e) {
      return handleDbError(reply, e);
    }
  });

  app.get<{ Params: { id: string } }>("/drafts/:id", async (req, reply) => {
    const d = db.getDraft(req.params.id);
    return d
      ? { draft: d, check: validateManifest(d.manifest, limits) }
      : reply.status(404).send({ error: "not_found" });
  });

  app.put<{ Params: { id: string } }>(
    "/drafts/:id/manifest",
    { bodyLimit: 512 * 1024 },
    async (req, reply) => {
      const d = db.getDraft(req.params.id);
      if (!d) return reply.status(404).send({ error: "not_found" });
      if (d.status !== "draft" && d.status !== "failed")
        return reply.status(409).send({ error: "bad_state" });
      const body = z.object({ manifest: z.unknown() }).safeParse(req.body);
      const v = validateManifest(body.success ? body.data.manifest : null, limits);
      if (!v.manifest)
        return reply.status(400).send({ error: "invalid_manifest", issues: v.errors });
      const updated = db.updateDraft(d.id, {
        manifest: v.manifest as ClipManifest,
        status: "draft",
      });
      return { draft: updated, check: validateManifest(updated.manifest, limits) };
    },
  );

  app.delete<{ Params: { id: string } }>("/drafts/:id", async (req) => {
    db.deleteDraft(req.params.id);
    await rm(draftDir(config.dataDir, req.params.id), { recursive: true, force: true });
    return { ok: true };
  });

  /** Resumable upload: GET tells how many bytes the server has, PUT appends at ?offset. */
  app.get<{ Params: { id: string; kind: string } }>(
    "/drafts/:id/files/:kind",
    async (req, reply) => {
      const d = db.getDraft(req.params.id);
      const kind = req.params.kind as SourceKind;
      if (!d || !KINDS.includes(kind)) return reply.status(404).send({ error: "not_found" });
      return { received: d.files[kind]?.received ?? 0, size: d.files[kind]?.size ?? null };
    },
  );

  app.put<{
    Params: { id: string; kind: string };
    Querystring: { offset?: string; total?: string; name?: string; proxy?: string };
  }>("/drafts/:id/files/:kind", { bodyLimit: MAX_CHUNK_BYTES }, async (req, reply) => {
    const d = db.getDraft(req.params.id);
    const kind = req.params.kind as SourceKind;
    if (!d || !KINDS.includes(kind)) return reply.status(404).send({ error: "not_found" });
    if (d.status !== "draft" && d.status !== "failed")
      return reply.status(409).send({ error: "bad_state" });
    const offset = Number(req.query.offset ?? 0);
    const total = Number(req.query.total ?? 0);
    const chunk = req.body;
    if (!Buffer.isBuffer(chunk)) return reply.status(415).send({ error: "octet_stream_required" });
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(total) ||
      total <= 0 ||
      total > MAX_SOURCE_BYTES
    ) {
      return reply.status(400).send({ error: "bad_range" });
    }
    const file = join(draftDir(config.dataDir, d.id), kind);
    await mkdir(draftDir(config.dataDir, d.id), { recursive: true });
    const current = existsSync(file) ? (await stat(file)).size : 0;
    if (offset === 0 && current > 0) await truncate(file, 0);
    else if (offset !== current)
      return reply.status(409).send({ error: "offset_mismatch", received: current });
    if (offset + chunk.length > total) return reply.status(400).send({ error: "bad_range" });
    const fh = await open(file, offset === 0 ? "w" : "a");
    try {
      await fh.write(chunk);
    } finally {
      await fh.close();
    }
    const received = offset + chunk.length;
    const files = { ...d.files, [kind]: { name: req.query.name ?? kind, size: total, received } };
    db.updateDraft(d.id, { files });
    // a complete source video gets a browser-safe editing proxy from the media worker
    // (the CLI submits right away and opts out with ?proxy=0)
    if (kind === "video" && received === total && req.query.proxy !== "0") db.requestProxy(d.id);
    return { received };
  });

  /** Signed link for streaming a long source's proxy in a <video> element (6 h). */
  app.get<{ Params: { id: string } }>("/drafts/:id/media-link", async (req, reply) => {
    const d = db.getDraft(req.params.id);
    if (!d) return reply.status(404).send({ error: "not_found" });
    const t = sign(
      { typ: "studio-media", draft: d.id, exp: Date.now() + 6 * 3600_000 },
      config.signingKeys[0]!,
    );
    return {
      proxy: `/api/studio/drafts/${d.id}/source/proxy?t=${t}`,
      peaks: `/api/studio/drafts/${d.id}/source/peaks?t=${t}`,
    };
  });

  /** Streams an uploaded source or its editing proxy (with Range) for markup in the Studio. */
  app.get<{ Params: { id: string; kind: string } }>(
    "/drafts/:id/source/:kind",
    async (req, reply) => {
      const d = db.getDraft(req.params.id);
      // "proxy" = browser-safe WebM made by the media worker for editing, "peaks" = its waveform
      const kind = req.params.kind as SourceKind | "proxy" | "peaks";
      if (!d || ![...KINDS, "proxy", "peaks"].includes(kind)) {
        return reply.status(404).send({ error: "not_found" });
      }
      const name = kind === "proxy" ? "proxy.webm" : kind === "peaks" ? "peaks.bin" : kind;
      const file = join(draftDir(config.dataDir, d.id), name);
      if (!existsSync(file)) return reply.status(404).send({ error: "not_found" });
      const size = (await stat(file)).size;
      reply.header("accept-ranges", "bytes");
      reply.header("cache-control", "no-store");
      reply.type(
        kind === "proxy"
          ? "video/webm"
          : kind === "peaks"
            ? "application/octet-stream"
            : kind === "video"
              ? "video/mp4"
              : "audio/wav",
      );
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end || start >= size)
          return reply.status(416).header("content-range", `bytes */${size}`).send();
        reply
          .status(206)
          .header("content-range", `bytes ${start}-${end}/${size}`)
          .header("content-length", end - start + 1);
        return reply.send(createReadStream(file, { start, end }));
      }
      reply.header("content-length", size);
      return reply.send(createReadStream(file));
    },
  );

  /** Export (§9.2 step 6): full validation, then queue for the media worker. */
  app.post<{ Params: { id: string } }>("/drafts/:id/submit", async (req, reply) => {
    const d = db.getDraft(req.params.id);
    if (!d) return reply.status(404).send({ error: "not_found" });
    if (d.status !== "draft" && d.status !== "failed")
      return reply.status(409).send({ error: "bad_state" });
    const video = d.files.video;
    if (!video || video.received !== video.size) {
      return reply
        .status(400)
        .send({ error: "video_missing", message: "видео не загружено полностью" });
    }
    for (const k of ["bed", "dialogue"] as const) {
      const f = d.files[k];
      if (f && f.received !== f.size) return reply.status(400).send({ error: `${k}_incomplete` });
    }
    // duration is re-measured by the worker from the real file; here check everything else
    const check = validateManifest(d.manifest, limits);
    const blocking = check.errors.filter((e) => e.code !== "duration" && e.code !== "line_bounds");
    if (blocking.length)
      return reply.status(400).send({ error: "invalid_manifest", issues: blocking });
    const updated = db.updateDraft(d.id, {
      status: "queued",
      progress: 0,
      errors: [],
      warnings: check.warnings,
    });
    return { draft: updated };
  });

  app.post<{ Params: { id: string; v: string } }>(
    "/clips/:id/versions/:v/publish",
    async (req, reply) => {
      try {
        db.publishVersion(req.params.id, Number(req.params.v));
        catalog.rebuild();
        return { ok: true };
      } catch (e) {
        return handleDbError(reply, e);
      }
    },
  );

  app.post<{ Params: { id: string; v: string } }>("/clips/:id/versions/:v/reject", async (req) => {
    const body = z.object({ reason: z.string().max(500).default("") }).safeParse(req.body ?? {});
    db.rejectVersion(req.params.id, Number(req.params.v), body.success ? body.data.reason : "");
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/clips/:id/archive", async (req) => {
    db.archiveClip(req.params.id);
    catalog.rebuild();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/clips/:id/unarchive", async (req) => {
    db.unarchiveClip(req.params.id);
    catalog.rebuild();
    return { ok: true };
  });

  app.get("/reports", async () => ({ reports: db.listReports() }));

  app.post<{ Params: { id: string } }>("/reports/:id/resolve", async (req) => {
    db.resolveReport(req.params.id);
    return { ok: true };
  });
}

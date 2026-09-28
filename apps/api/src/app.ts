import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { Db } from "@dubroom/db";
import type { ApiConfig } from "./config.ts";
import { CatalogCache } from "./catalog.ts";
import { publicRoutes } from "./routes/public.ts";
import { studioRoutes } from "./routes/studio.ts";

export interface AppDeps {
  config: ApiConfig;
  db: Db;
  catalog: CatalogCache;
}

declare module "fastify" {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export function clientIp(
  req: { headers: Record<string, unknown>; ip: string },
  trustCf: boolean,
): string {
  const cf = req.headers["cf-connecting-ip"];
  return trustCf && typeof cf === "string" && cf ? cf : req.ip;
}

export async function buildApp(config: ApiConfig, db: Db): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      process.env.NODE_ENV === "test"
        ? false
        : {
            level: process.env.LOG_LEVEL ?? "info",
            // never log secrets, tickets or tokens (§22.8)
            redact: [
              "req.headers.authorization",
              "req.headers['x-upload-ticket']",
              "req.headers.cookie",
              "req.headers['cf-access-jwt-assertion']",
            ],
          },
    trustProxy: true,
    bodyLimit: 64 * 1024,
    // don't leak stack traces or versions (§22.10)
    return503OnClosing: true,
  });

  for (const dir of ["clips", "dubs", "uploads", "public"])
    mkdirSync(join(config.dataDir, dir), { recursive: true });
  const catalog = new CatalogCache(db, config);
  app.decorate("deps", { config, db, catalog });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error(err);
    reply
      .status(status)
      .send(
        status >= 500
          ? { error: "internal_error" }
          : { error: err.code ?? "bad_request", message: err.message },
      );
  });

  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => clientIp(req, config.trustCfIp),
  });

  // raw bodies for uploads (dubs, studio chunks) — parsed as Buffer, size limited per route
  app.addContentTypeParser(
    ["application/octet-stream", "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "video/mp4"],
    { parseAs: "buffer", bodyLimit: 60 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  await app.register(publicRoutes);
  await app.register(studioRoutes, { prefix: "/api/studio" });

  // In production Caddy serves /media/clips straight from the volume; this is for dev and tests.
  if (config.serveMedia) {
    await app.register(fastifyStatic, {
      root: join(config.dataDir, "clips"),
      prefix: "/media/clips/",
      decorateReply: false,
      immutable: true,
      maxAge: "365d",
    });
  }

  return app;
}

import { join, resolve } from "node:path";
import { parseKeys } from "@dubroom/shared/token";

export interface ApiConfig {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  /** public prefix for media URLs in the catalog (Caddy serves DATA_DIR/clips at /media/clips) */
  mediaBase: string;
  /** keys[0] signs; all keys verify (rotation, §22.8) */
  signingKeys: string[];
  studioKey: string;
  /** when set, /api/studio/* is only accepted with this Host header (§22.10) */
  studioHost: string | null;
  /** Cloudflare Access verification for Studio (optional) */
  cfAccess: { teamDomain: string; aud: string } | null;
  /** trust CF-Connecting-IP (only behind cloudflared + caddy, §21.7) */
  trustCfIp: boolean;
  dubTtlMs: number;
  dubMaxBytes: number;
  serveMedia: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const dataDir = resolve(env.DATA_DIR ?? "./data");
  const studioKey = env.STUDIO_KEY ?? "";
  if (studioKey.length < 16) throw new Error("STUDIO_KEY must be at least 16 characters");
  return {
    port: Number(env.API_PORT ?? 3000),
    host: env.API_HOST ?? "0.0.0.0",
    dataDir,
    dbPath: env.DB_PATH ?? join(dataDir, "db", "dubroom.sqlite"),
    mediaBase: env.MEDIA_BASE_URL ?? "/media",
    signingKeys: parseKeys(env.TOKEN_SIGNING_KEY),
    studioKey,
    studioHost: env.STUDIO_HOST || null,
    cfAccess:
      env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD
        ? { teamDomain: env.CF_ACCESS_TEAM_DOMAIN, aud: env.CF_ACCESS_AUD }
        : null,
    trustCfIp: env.TRUST_CF_CONNECTING_IP === "true",
    dubTtlMs: Number(env.DUB_TTL_HOURS ?? 24) * 3600_000,
    dubMaxBytes: 2 * 1024 * 1024,
    serveMedia: env.SERVE_MEDIA !== "false",
  };
}

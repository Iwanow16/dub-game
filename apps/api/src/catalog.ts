import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@dubroom/db";
import type { Catalog } from "@dubroom/shared";
import type { ApiConfig } from "./config.ts";

/**
 * catalog.json (§11.2): built from published versions, cached in memory and mirrored to
 * DATA_DIR/public/catalog.json so Caddy/Cloudflare can serve it with short-lived caching.
 */
export class CatalogCache {
  private cached: { body: string; etag: string } | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: ApiConfig,
  ) {}

  get(): { body: string; etag: string } {
    if (!this.cached) this.rebuild();
    return this.cached!;
  }

  data(): Catalog {
    return JSON.parse(this.get().body) as Catalog;
  }

  rebuild() {
    const catalog = this.db.buildCatalog(this.config.mediaBase);
    const body = JSON.stringify(catalog);
    const etag = `"${hash(body)}"`;
    this.cached = { body, etag };
    const file = join(this.config.dataDir, "public", "catalog.json");
    writeFileSync(file + ".tmp", body);
    renameSync(file + ".tmp", file);
  }
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

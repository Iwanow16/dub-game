import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sceneLines, sceneRoleCount, type ClipManifest, type Issue } from "@dubroom/clip-format";
import type { Catalog, CatalogEntry } from "@dubroom/shared";

/**
 * Metadata store (§7). MVP uses SQLite through node:sqlite (see docs/adr/0003-sqlite-for-mvp.md):
 * one file on a shared volume, used by the API and the network-less media worker.
 * Repository functions keep SQL in one place so moving to PostgreSQL touches only this package.
 */

export type ClipStatus = "draft" | "processing" | "review" | "published" | "archived";
export type VersionStatus =
  "processing" | "review" | "published" | "rejected" | "failed" | "superseded";
export type DraftStatus = "draft" | "queued" | "processing" | "done" | "failed";
export type SourceKind = "video" | "bed" | "dialogue";

export interface DraftFile {
  name: string;
  size: number;
  received: number;
}

export type ProxyStatus = "none" | "queued" | "processing" | "done" | "failed";

export interface Draft {
  id: string;
  clipId: string;
  version: number;
  status: DraftStatus;
  manifest: ClipManifest;
  files: Partial<Record<SourceKind, DraftFile>>;
  warnings: Issue[];
  errors: Issue[];
  progress: number;
  proxyStatus: ProxyStatus;
  /** measured by the worker with ffprobe */
  sourceDurationMs: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface ClipVersion {
  clipId: string;
  version: number;
  status: VersionStatus;
  manifest: ClipManifest | null;
  warnings: Issue[];
  error: string | null;
  createdAt: number;
}

export interface ClipRow {
  id: string;
  slug: string;
  status: ClipStatus;
  currentVersion: number | null;
  createdAt: number;
  publishedAt: number | null;
  versions: ClipVersion[];
}

const MIGRATIONS: string[] = [
  `CREATE TABLE clips (
     id TEXT PRIMARY KEY,
     slug TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL CHECK (status IN ('draft','processing','review','published','archived')),
     current_version INTEGER,
     created_at INTEGER NOT NULL,
     published_at INTEGER
   );
   CREATE TABLE clip_versions (
     clip_id TEXT NOT NULL REFERENCES clips(id),
     version INTEGER NOT NULL,
     status TEXT NOT NULL,
     manifest_json TEXT,
     warnings_json TEXT NOT NULL DEFAULT '[]',
     error TEXT,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (clip_id, version)
   );
   CREATE TABLE clip_tags (clip_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (clip_id, tag));
   CREATE TABLE clip_stats (clip_id TEXT PRIMARY KEY, plays INTEGER NOT NULL DEFAULT 0,
     avg_score REAL NOT NULL DEFAULT 0, skips INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE drafts (
     id TEXT PRIMARY KEY,
     clip_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     status TEXT NOT NULL,
     manifest_json TEXT NOT NULL,
     files_json TEXT NOT NULL DEFAULT '{}',
     warnings_json TEXT NOT NULL DEFAULT '[]',
     errors_json TEXT NOT NULL DEFAULT '[]',
     progress REAL NOT NULL DEFAULT 0,
     created_by TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX drafts_status ON drafts(status);
   CREATE TABLE guests (
     player_id TEXT PRIMARY KEY,
     secret_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_seen INTEGER NOT NULL
   );
   CREATE TABLE dubs (
     id TEXT PRIMARY KEY,
     room TEXT NOT NULL,
     round INTEGER NOT NULL,
     player_id TEXT NOT NULL,
     path TEXT NOT NULL,
     mime TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX dubs_expires ON dubs(expires_at);
   CREATE TABLE reports (
     id TEXT PRIMARY KEY,
     target_type TEXT NOT NULL,
     target_id TEXT NOT NULL,
     reason TEXT NOT NULL,
     reporter_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     resolved_at INTEGER
   );`,
  // 2: editing proxy for Clip Studio (browser-safe preview of the source)
  `ALTER TABLE drafts ADD COLUMN proxy_status TEXT NOT NULL DEFAULT 'none';
   ALTER TABLE drafts ADD COLUMN source_duration_ms INTEGER;
   CREATE INDEX drafts_proxy ON drafts(proxy_status);`,
];

type Row = Record<string, unknown>;
const json = <T>(v: unknown, fallback: T): T =>
  typeof v === "string" ? (JSON.parse(v) as T) : fallback;

export class Db {
  readonly sql: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.migrate();
  }

  private migrate() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
    const row = this.sql.prepare("SELECT v FROM schema_version").get() as Row | undefined;
    let v = row ? Number(row.v) : 0;
    if (!row) this.sql.exec("INSERT INTO schema_version (v) VALUES (0)");
    for (; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.sql.exec(MIGRATIONS[v]!);
        this.sql.prepare("UPDATE schema_version SET v = ?").run(v + 1);
      });
    }
  }

  tx<T>(fn: () => T): T {
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.sql.exec("COMMIT");
      return r;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
  }

  close() {
    this.sql.close();
  }

  /* ---------- guests ---------- */

  getGuest(playerId: string): { secretHash: string } | null {
    const r = this.sql
      .prepare("SELECT secret_hash FROM guests WHERE player_id = ?")
      .get(playerId) as Row | undefined;
    return r ? { secretHash: String(r.secret_hash) } : null;
  }

  upsertGuest(playerId: string, secretHash: string, now = Date.now()) {
    this.sql
      .prepare(
        `INSERT INTO guests (player_id, secret_hash, created_at, last_seen) VALUES (?, ?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET last_seen = excluded.last_seen`,
      )
      .run(playerId, secretHash, now, now);
  }

  /* ---------- dubs ---------- */

  insertDub(d: {
    id: string;
    room: string;
    round: number;
    playerId: string;
    path: string;
    mime: string;
    bytes: number;
    ttlMs: number;
  }) {
    const now = Date.now();
    this.sql
      .prepare(
        `INSERT OR REPLACE INTO dubs (id, room, round, player_id, path, mime, bytes, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.id, d.room, d.round, d.playerId, d.path, d.mime, d.bytes, now, now + d.ttlMs);
  }

  getDub(id: string): { path: string; mime: string; expiresAt: number } | null {
    const r = this.sql.prepare("SELECT path, mime, expires_at FROM dubs WHERE id = ?").get(id) as
      Row | undefined;
    return r
      ? { path: String(r.path), mime: String(r.mime), expiresAt: Number(r.expires_at) }
      : null;
  }

  takeExpiredDubs(now = Date.now()): string[] {
    return this.tx(() => {
      const rows = this.sql.prepare("SELECT path FROM dubs WHERE expires_at < ?").all(now) as Row[];
      this.sql.prepare("DELETE FROM dubs WHERE expires_at < ?").run(now);
      return rows.map((r) => String(r.path));
    });
  }

  /* ---------- reports ---------- */

  insertReport(r: {
    id: string;
    targetType: string;
    targetId: string;
    reason: string;
    reporterId: string;
  }) {
    this.sql
      .prepare(
        "INSERT INTO reports (id, target_type, target_id, reason, reporter_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(r.id, r.targetType, r.targetId, r.reason, r.reporterId, Date.now());
  }

  listReports(): Row[] {
    return this.sql
      .prepare("SELECT * FROM reports ORDER BY created_at DESC LIMIT 200")
      .all() as Row[];
  }

  resolveReport(id: string) {
    this.sql.prepare("UPDATE reports SET resolved_at = ? WHERE id = ?").run(Date.now(), id);
  }

  /* ---------- drafts ---------- */

  private toDraft(r: Row): Draft {
    return {
      id: String(r.id),
      clipId: String(r.clip_id),
      version: Number(r.version),
      status: String(r.status) as DraftStatus,
      manifest: json<ClipManifest>(r.manifest_json, null as unknown as ClipManifest),
      files: json(r.files_json, {}),
      warnings: json(r.warnings_json, []),
      errors: json(r.errors_json, []),
      progress: Number(r.progress),
      proxyStatus: String(r.proxy_status ?? "none") as ProxyStatus,
      sourceDurationMs: r.source_duration_ms == null ? null : Number(r.source_duration_ms),
      createdBy: String(r.created_by),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  /**
   * Creates a draft for a new clip or a new version of an existing clip (matched by manifest id).
   * The version number is reserved immediately so concurrent drafts do not collide.
   */
  createDraft(id: string, manifest: ClipManifest, createdBy: string): Draft {
    return this.tx(() => {
      const now = Date.now();
      const existing = this.sql.prepare("SELECT id FROM clips WHERE id = ?").get(manifest.id) as
        Row | undefined;
      if (!existing) {
        const slugTaken = this.sql
          .prepare("SELECT id FROM clips WHERE slug = ?")
          .get(manifest.slug);
        if (slugTaken) throw new DbError("slug_taken", `slug «${manifest.slug}» уже занят`);
        this.sql
          .prepare("INSERT INTO clips (id, slug, status, created_at) VALUES (?, ?, 'draft', ?)")
          .run(manifest.id, manifest.slug, now);
      }
      const maxV = this.sql
        .prepare(
          `SELECT MAX(v) AS v FROM (SELECT version AS v FROM clip_versions WHERE clip_id = ?
           UNION ALL SELECT version AS v FROM drafts WHERE clip_id = ?)`,
        )
        .get(manifest.id, manifest.id) as Row;
      const version = (Number(maxV.v) || 0) + 1;
      const m = { ...manifest, version };
      this.sql
        .prepare(
          `INSERT INTO drafts (id, clip_id, version, status, manifest_json, created_by, created_at, updated_at)
           VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)`,
        )
        .run(id, manifest.id, version, JSON.stringify(m), createdBy, now, now);
      return this.getDraft(id)!;
    });
  }

  getDraft(id: string): Draft | null {
    const r = this.sql.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toDraft(r) : null;
  }

  listDrafts(): Draft[] {
    return (
      this.sql.prepare("SELECT * FROM drafts ORDER BY updated_at DESC LIMIT 200").all() as Row[]
    ).map((r) => this.toDraft(r));
  }

  updateDraft(
    id: string,
    patch: Partial<
      Pick<Draft, "status" | "manifest" | "files" | "warnings" | "errors" | "progress">
    >,
  ) {
    const d = this.getDraft(id);
    if (!d) throw new DbError("not_found", "draft not found");
    const n = { ...d, ...patch };
    // clip id and version are fixed at creation
    n.manifest = { ...n.manifest, id: d.clipId, version: d.version };
    this.sql
      .prepare(
        `UPDATE drafts SET status = ?, manifest_json = ?, files_json = ?, warnings_json = ?, errors_json = ?,
         progress = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        n.status,
        JSON.stringify(n.manifest),
        JSON.stringify(n.files),
        JSON.stringify(n.warnings),
        JSON.stringify(n.errors),
        n.progress,
        Date.now(),
        id,
      );
    return this.getDraft(id)!;
  }

  deleteDraft(id: string) {
    this.sql.prepare("DELETE FROM drafts WHERE id = ? AND status IN ('draft','failed')").run(id);
  }

  /** Atomically claims the oldest queued draft for processing (media worker). */
  claimQueuedDraft(): Draft | null {
    return this.tx(() => {
      const r = this.sql
        .prepare("SELECT id FROM drafts WHERE status = 'queued' ORDER BY updated_at LIMIT 1")
        .get() as Row | undefined;
      if (!r) return null;
      this.sql
        .prepare(
          "UPDATE drafts SET status = 'processing', progress = 0, updated_at = ? WHERE id = ?",
        )
        .run(Date.now(), r.id as string);
      const d = this.getDraft(String(r.id))!;
      this.sql
        .prepare(
          `INSERT OR REPLACE INTO clip_versions (clip_id, version, status, manifest_json, created_at)
           VALUES (?, ?, 'processing', NULL, ?)`,
        )
        .run(d.clipId, d.version, Date.now());
      this.refreshClipStatus(d.clipId);
      return d;
    });
  }

  /* ---------- editing proxy ---------- */

  requestProxy(id: string) {
    this.sql
      .prepare("UPDATE drafts SET proxy_status = 'queued', source_duration_ms = NULL WHERE id = ?")
      .run(id);
  }

  claimProxyJob(): Draft | null {
    return this.tx(() => {
      const r = this.sql
        .prepare("SELECT id FROM drafts WHERE proxy_status = 'queued' ORDER BY updated_at LIMIT 1")
        .get() as Row | undefined;
      if (!r) return null;
      this.sql
        .prepare("UPDATE drafts SET proxy_status = 'processing' WHERE id = ?")
        .run(String(r.id));
      return this.getDraft(String(r.id));
    });
  }

  finishProxy(id: string, result: { durationMs: number } | { error: string }) {
    if ("durationMs" in result) {
      this.sql
        .prepare("UPDATE drafts SET proxy_status = 'done', source_duration_ms = ? WHERE id = ?")
        .run(result.durationMs, id);
    } else {
      this.sql
        .prepare("UPDATE drafts SET proxy_status = 'failed', errors_json = ? WHERE id = ?")
        .run(JSON.stringify([{ code: "proxy", path: "source.video", message: result.error }]), id);
    }
  }

  /** Drafts stuck in "processing" (worker crashed) go back to the queue. */
  requeueStale(olderThanMs: number) {
    this.sql
      .prepare("UPDATE drafts SET status = 'queued' WHERE status = 'processing' AND updated_at < ?")
      .run(Date.now() - olderThanMs);
    this.sql
      .prepare("UPDATE drafts SET proxy_status = 'queued' WHERE proxy_status = 'processing'")
      .run();
  }

  finishProcessing(
    draftId: string,
    result: { manifest: ClipManifest; warnings: Issue[] } | { error: string; issues: Issue[] },
  ) {
    this.tx(() => {
      const d = this.getDraft(draftId);
      if (!d) return;
      if ("manifest" in result) {
        this.sql
          .prepare(
            "UPDATE clip_versions SET status = 'review', manifest_json = ?, warnings_json = ?, error = NULL WHERE clip_id = ? AND version = ?",
          )
          .run(
            JSON.stringify(result.manifest),
            JSON.stringify(result.warnings),
            d.clipId,
            d.version,
          );
        this.updateDraft(draftId, {
          status: "done",
          progress: 1,
          warnings: result.warnings,
          errors: [],
        });
        for (const tag of result.manifest.tags) {
          this.sql
            .prepare("INSERT OR IGNORE INTO clip_tags (clip_id, tag) VALUES (?, ?)")
            .run(d.clipId, tag);
        }
      } else {
        this.sql
          .prepare(
            "UPDATE clip_versions SET status = 'failed', error = ? WHERE clip_id = ? AND version = ?",
          )
          .run(result.error, d.clipId, d.version);
        this.updateDraft(draftId, {
          status: "failed",
          errors: result.issues.length
            ? result.issues
            : [{ code: "build", path: "", message: result.error }],
        });
      }
      this.refreshClipStatus(d.clipId);
    });
  }

  /* ---------- clips & moderation ---------- */

  private refreshClipStatus(clipId: string) {
    const clip = this.sql
      .prepare("SELECT status, current_version FROM clips WHERE id = ?")
      .get(clipId) as Row | undefined;
    if (!clip || clip.status === "archived") return;
    const versions = this.listVersions(clipId);
    let status: ClipStatus = "draft";
    if (clip.current_version != null) status = "published";
    else if (versions.some((v) => v.status === "review")) status = "review";
    else if (versions.some((v) => v.status === "processing")) status = "processing";
    this.sql.prepare("UPDATE clips SET status = ? WHERE id = ?").run(status, clipId);
  }

  listVersions(clipId: string): ClipVersion[] {
    return (
      this.sql
        .prepare("SELECT * FROM clip_versions WHERE clip_id = ? ORDER BY version DESC")
        .all(clipId) as Row[]
    ).map((r) => ({
      clipId: String(r.clip_id),
      version: Number(r.version),
      status: String(r.status) as VersionStatus,
      manifest: json<ClipManifest | null>(r.manifest_json, null),
      warnings: json(r.warnings_json, []),
      error: r.error == null ? null : String(r.error),
      createdAt: Number(r.created_at),
    }));
  }

  listClips(): ClipRow[] {
    return (this.sql.prepare("SELECT * FROM clips ORDER BY created_at DESC").all() as Row[]).map(
      (r) => ({
        id: String(r.id),
        slug: String(r.slug),
        status: String(r.status) as ClipStatus,
        currentVersion: r.current_version == null ? null : Number(r.current_version),
        createdAt: Number(r.created_at),
        publishedAt: r.published_at == null ? null : Number(r.published_at),
        versions: this.listVersions(String(r.id)),
      }),
    );
  }

  /** Moderation (§9.2 steps 8–9): publish a reviewed version, superseding the previous one. */
  publishVersion(clipId: string, version: number) {
    this.tx(() => this.doPublish(clipId, version));
  }

  private doPublish(clipId: string, version: number) {
    {
      const v = this.sql
        .prepare("SELECT status FROM clip_versions WHERE clip_id = ? AND version = ?")
        .get(clipId, version) as Row | undefined;
      if (!v) throw new DbError("not_found", "version not found");
      if (!["review", "superseded", "published"].includes(String(v.status))) {
        throw new DbError("bad_state", `version is ${String(v.status)}`);
      }
      this.sql
        .prepare(
          "UPDATE clip_versions SET status = 'superseded' WHERE clip_id = ? AND status = 'published'",
        )
        .run(clipId);
      this.sql
        .prepare("UPDATE clip_versions SET status = 'published' WHERE clip_id = ? AND version = ?")
        .run(clipId, version);
      this.sql
        .prepare(
          "UPDATE clips SET status = 'published', current_version = ?, published_at = ? WHERE id = ?",
        )
        .run(version, Date.now(), clipId);
    }
  }

  rejectVersion(clipId: string, version: number, reason: string) {
    this.tx(() => {
      this.sql
        .prepare(
          "UPDATE clip_versions SET status = 'rejected', error = ? WHERE clip_id = ? AND version = ? AND status = 'review'",
        )
        .run(reason, clipId, version);
      this.refreshClipStatus(clipId);
    });
  }

  archiveClip(clipId: string) {
    this.sql
      .prepare("UPDATE clips SET status = 'archived', current_version = NULL WHERE id = ?")
      .run(clipId);
  }

  unarchiveClip(clipId: string) {
    this.tx(() => {
      const pub = this.sql
        .prepare(
          "SELECT MAX(version) AS v FROM clip_versions WHERE clip_id = ? AND status IN ('published','superseded')",
        )
        .get(clipId) as Row;
      this.sql
        .prepare("UPDATE clips SET status = 'draft', current_version = ? WHERE id = ?")
        .run((pub.v as number | null) ?? null, clipId);
      if (pub.v != null) this.doPublish(clipId, Number(pub.v));
      else this.refreshClipStatus(clipId);
    });
  }

  /** Builds catalog.json content from published versions (§11.2). */
  buildCatalog(mediaBase: string): Catalog {
    const rows = this.sql
      .prepare(
        `SELECT v.manifest_json FROM clips c JOIN clip_versions v
         ON v.clip_id = c.id AND v.version = c.current_version
         WHERE c.status = 'published' ORDER BY c.published_at DESC`,
      )
      .all() as Row[];
    const clips: CatalogEntry[] = rows.map((r) => {
      const m = JSON.parse(String(r.manifest_json)) as ClipManifest;
      const base = `${mediaBase}/clips/${m.id}/v${m.version}`;
      return {
        id: m.id,
        slug: m.slug,
        version: m.version,
        title: m.title,
        durationMs: m.durationMs,
        rolesCount: m.roles.length,
        ageRating: m.ageRating,
        tags: m.tags,
        credit: m.credit,
        manifestUrl: `${base}/manifest.json`,
        posterUrl: `${base}/${m.media!.poster}`,
        previewUrl: m.media!.preview ? `${base}/${m.media!.preview}` : null,
        // scenes of long clips (ADR-0009); only those the worker has cut media for
        scenes: (m.scenes ?? [])
          .filter((sc) => sc.media)
          .map((sc) => ({
            id: sc.id,
            startMs: sc.startMs,
            endMs: sc.endMs,
            ...(sc.title ? { title: sc.title } : {}),
            rolesCount: Math.max(1, sceneRoleCount(m.lines, sc)),
            roleIds: [...new Set(sceneLines(m.lines, sc).map((l) => l.role))].sort(),
            posterUrl: `${base}/${sc.media!.poster}`,
          })),
      };
    });
    return { schema: "dubroom.catalog/1", generatedAt: new Date().toISOString(), clips };
  }

  recordPlay(clipId: string) {
    this.sql
      .prepare(
        "INSERT INTO clip_stats (clip_id, plays) VALUES (?, 1) ON CONFLICT(clip_id) DO UPDATE SET plays = plays + 1",
      )
      .run(clipId);
  }
}

export class DbError extends Error {
  constructor(
    readonly code: "not_found" | "slug_taken" | "bad_state",
    message: string,
  ) {
    super(message);
  }
}

import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Issue } from "@dubroom/clip-format";
import { BuildError, buildPackage } from "@dubroom/clip-format/node";
import type { Db, Draft } from "@dubroom/db";

export interface WorkerOptions {
  dataDir: string;
  /** per-ffmpeg-call timeout (§22.6) */
  jobTimeoutMs: number;
  log: (msg: string, extra?: object) => void;
}

/**
 * Processes one queued draft: sources in DATA_DIR/uploads/<draft>/ → package in
 * DATA_DIR/clips/<clipId>/v<version>/ (served as /media/clips/…). Output is written to a temp
 * directory and swapped in atomically, so a half-built package is never visible.
 */
export async function processDraft(db: Db, draft: Draft, opts: WorkerOptions): Promise<boolean> {
  const src = join(opts.dataDir, "uploads", draft.id);
  const finalDir = join(opts.dataDir, "clips", draft.clipId, `v${draft.version}`);
  const tmpDir = `${finalDir}.tmp-${process.pid}`;
  const file = (k: "video" | "bed" | "dialogue") =>
    draft.files[k] && existsSync(join(src, k)) ? join(src, k) : undefined;

  const video = file("video");
  if (!video) {
    db.finishProcessing(draft.id, { error: "видео не найдено", issues: [] });
    return false;
  }
  opts.log("processing", { draft: draft.id, clip: draft.clipId, version: draft.version });
  let lastProgress = 0;
  try {
    const result = await buildPackage({
      manifest: draft.manifest,
      video,
      bed: file("bed"),
      dialogue: file("dialogue"),
      outDir: tmpDir,
      timeoutMs: opts.jobTimeoutMs,
      log: (m) => opts.log(m, { draft: draft.id }),
      onProgress: (p) => {
        if (p - lastProgress >= 0.05 || p === 1) {
          lastProgress = p;
          db.updateDraft(draft.id, { progress: p });
        }
      },
    });
    await rm(finalDir, { recursive: true, force: true });
    await rename(tmpDir, finalDir);
    db.finishProcessing(draft.id, result);
    opts.log("done", { draft: draft.id, warnings: result.warnings.length });
    return true;
  } catch (e) {
    await rm(tmpDir, { recursive: true, force: true });
    const issues: Issue[] = e instanceof BuildError ? e.issues : [];
    const message = e instanceof Error ? e.message.slice(0, 1000) : String(e);
    db.finishProcessing(draft.id, { error: message, issues });
    opts.log("failed", { draft: draft.id, error: message });
    return false;
  }
}

/** Polling loop; SQLite gives atomic claiming, so several workers may run side by side. */
export async function runWorker(
  db: Db,
  opts: WorkerOptions & { pollMs: number; signal: AbortSignal },
) {
  db.requeueStale(opts.jobTimeoutMs * 6);
  while (!opts.signal.aborted) {
    const draft = db.claimQueuedDraft();
    if (draft) {
      await processDraft(db, draft, opts);
      continue;
    }
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
}

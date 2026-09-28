import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { emptyManifest } from "@dubroom/clip-format";
import { synthesizeSource } from "@dubroom/clip-format/node";
import { Db } from "@dubroom/db";
import { processDraft, processProxy } from "./worker.ts";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("media worker", () => {
  let dir = "";
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("turns a queued draft into a reviewable package, and fails bad input cleanly", async () => {
    dir = await mkdtemp(join(tmpdir(), "dubroom-worker-"));
    const db = new Db(join(dir, "db.sqlite"));
    const manifest = emptyManifest({
      id: "c_worker00001",
      slug: "worker-test",
      durationMs: 6000,
      credit: "DubRoom",
      license: "Own work",
      lines: [{ id: "l1", role: "r1", startMs: 1000, endMs: 2500, text: { ru: "Раз-два" } }],
    });
    const gen = join(dir, "gen");
    const { video, bed } = await synthesizeSource(manifest, gen, { background: "color" });

    const draft = db.createDraft(randomUUID(), manifest, "test");
    const up = join(dir, "uploads", draft.id);
    await mkdir(up, { recursive: true });
    await copyFile(video, join(up, "video"));
    await copyFile(bed, join(up, "bed"));
    const size = (p: string) => stat(p).then((s) => s.size);
    db.updateDraft(draft.id, {
      status: "queued",
      files: {
        video: { name: "v", size: await size(video), received: await size(video) },
        bed: { name: "b", size: await size(bed), received: await size(bed) },
      },
    });

    const log = () => {};
    db.requestProxy(draft.id);
    const proxyJob = db.claimProxyJob()!;
    expect(await processProxy(db, proxyJob, { dataDir: dir, jobTimeoutMs: 60_000, log })).toBe(
      true,
    );
    expect(db.getDraft(draft.id)).toMatchObject({ proxyStatus: "done", sourceDurationMs: 6000 });
    expect(existsSync(join(up, "proxy.webm"))).toBe(true);

    const claimed = db.claimQueuedDraft()!;
    expect(await processDraft(db, claimed, { dataDir: dir, jobTimeoutMs: 120_000, log })).toBe(
      true,
    );
    expect(db.getDraft(draft.id)!.status).toBe("done");
    expect(existsSync(join(dir, "clips", "c_worker00001", "v1", "manifest.json"))).toBe(true);
    expect(db.listClips()[0]!.status).toBe("review");

    // garbage "video" is rejected by the ffprobe whitelist, nothing is published
    const bad = db.createDraft(randomUUID(), manifest, "test");
    const badDir = join(dir, "uploads", bad.id);
    await mkdir(badDir, { recursive: true });
    await copyFile(bed, join(badDir, "video")); // audio-only file pretending to be video
    db.updateDraft(bad.id, {
      status: "queued",
      files: { video: { name: "v", size: 1, received: 1 } },
    });
    expect(
      await processDraft(db, db.claimQueuedDraft()!, { dataDir: dir, jobTimeoutMs: 60_000, log }),
    ).toBe(false);
    const failed = db.getDraft(bad.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.errors.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, "clips", "c_worker00001", "v2"))).toBe(false);
    db.close();
  }, 180_000);
});

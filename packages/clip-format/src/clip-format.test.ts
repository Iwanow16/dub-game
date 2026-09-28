import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  SCENE_LIMITS,
  autoScenes,
  emptyManifest,
  linesFromSrt,
  parseSrt,
  sceneLines,
  toVtt,
  validateManifest,
  type ClipManifest,
} from "./index.ts";
import { buildPackage, buildProxy, synthesizeSource } from "./node.ts";

const good = (): ClipManifest =>
  emptyManifest({
    id: "c_testclip01",
    slug: "space-cat",
    title: { ru: "Кот-переговорщик", en: "Negotiator Cat" },
    durationMs: 12_000,
    credit: "Команда DubRoom",
    license: "Own work",
    roles: [
      { id: "r1", name: { ru: "Кот" }, color: "#FF8A3D" },
      { id: "r2", name: { ru: "Пёс" }, color: "#3DA5FF" },
    ],
    lines: [
      {
        id: "l1",
        role: "r1",
        startMs: 1200,
        endMs: 3900,
        text: { ru: "Мы оба знаем, чья это миска." },
        hint: "уверенно",
      },
      {
        id: "l2",
        role: "r2",
        startMs: 4300,
        endMs: 6100,
        text: { ru: "Закон джунглей на моей стороне." },
      },
    ],
  });

describe("validateManifest", () => {
  it("accepts a good manifest", () => {
    const r = validateManifest(good());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("enforces §9.3 rules", () => {
    const m = good();
    m.durationMs = 3000;
    m.credit = "";
    m.license = "";
    m.lines.push({ id: "l3", role: "r1", startMs: 2000, endMs: 2500, text: { ru: "пересечение" } });
    m.lines.push({ id: "l4", role: "r9", startMs: 100, endMs: 50, text: { ru: "?" } });
    const codes = [...new Set(validateManifest(m).errors.map((e) => e.code))].sort();
    expect(codes).toEqual(
      [
        "credit",
        "duration",
        "license",
        "line_bounds",
        "line_order",
        "line_overlap",
        "line_role",
      ].sort(),
    );
  });

  it("requires at least one line and reports schema errors", () => {
    const m = good();
    m.lines = [];
    expect(validateManifest(m).errors.map((e) => e.code)).toContain("no_lines");
    expect(validateManifest({ schema: "nope" }).ok).toBe(false);
  });

  it("warns about unknown licenses and unused roles", () => {
    const m = good();
    m.license = "какая-то";
    m.roles.push({ id: "r3", name: { ru: "Лишний" }, color: "#FFFFFF" });
    const w = validateManifest(m).warnings.map((x) => x.code);
    expect(w).toContain("license_unknown");
    expect(w).toContain("role_unused");
  });
});

describe("long clips and scenes", () => {
  it("accepts long clips up to the configured maximum", () => {
    const m = good();
    m.durationMs = 25 * 60_000;
    const r = validateManifest(m);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain("scenes_auto");
    expect(validateManifest(m, { maxDurationMs: 10 * 60_000 }).errors.map((e) => e.code)).toContain(
      "duration",
    );
  });

  it("validates scenes: length, overlap, lines cut by a boundary", () => {
    const m = good();
    m.scenes = [
      { id: "s1", startMs: 0, endMs: 4000 }, // cuts l2? no: l2 is 4300–6100; too short
      { id: "s2", startMs: 3000, endMs: 12_000 }, // overlaps s1, cuts l1 (1200–3900)
    ];
    const codes = validateManifest(m).errors.map((e) => e.code);
    expect(codes).toContain("scene_length");
    expect(codes).toContain("scene_overlap");
    expect(codes).toContain("scene_cuts_line");
    m.scenes = [
      { id: "s1", startMs: 0, endMs: 7_000 },
      { id: "s2", startMs: 7_000, endMs: 12_000 },
    ];
    const ok = validateManifest(m);
    expect(ok.errors).toEqual([]);
    expect(ok.warnings.map((w) => w.code)).toContain("scene_empty"); // s2 has no lines
  });

  it("re-times scene lines from the scene start", () => {
    expect(sceneLines(good().lines, { startMs: 4000, endMs: 10_000 })).toEqual([
      expect.objectContaining({ id: "l2", startMs: 300, endMs: 2100 }),
    ]);
  });

  it("splits long clips at pauses, never inside a line, near the target length", () => {
    // 10 minutes of dialogue: a 3 s line every 5 s, with a long pause every ~50 s
    const lines: { startMs: number; endMs: number }[] = [];
    for (let t = 1000; t < 600_000; t += 5000) {
      if (t % 50_000 < 5000) t += 2500;
      lines.push({ startMs: t, endMs: t + 3000 });
    }
    const scenes = autoScenes(lines, 600_000);
    expect(scenes[0]!.startMs).toBe(0);
    expect(scenes[scenes.length - 1]!.endMs).toBe(600_000);
    for (const [i, sc] of scenes.entries()) {
      if (i > 0) expect(sc.startMs).toBe(scenes[i - 1]!.endMs);
      const len = sc.endMs - sc.startMs;
      expect(len).toBeGreaterThanOrEqual(SCENE_LIMITS.minMs);
      expect(len).toBeLessThanOrEqual(SCENE_LIMITS.maxMs);
      for (const l of lines) {
        const crosses =
          l.startMs < sc.endMs &&
          l.endMs > sc.startMs &&
          (l.startMs < sc.startMs || l.endMs > sc.endMs);
        expect(crosses).toBe(false);
      }
    }
    const avg = 600_000 / scenes.length;
    expect(avg).toBeGreaterThan(25_000);
    expect(avg).toBeLessThan(80_000);
    // most cuts land on the 2 s keyframe grid (lossless stream copy)
    expect(scenes.filter((s) => s.startMs % 2000 === 0).length / scenes.length).toBeGreaterThan(
      0.8,
    );
  });

  it("keeps a short clip as one scene and handles clips without dialogue", () => {
    expect(autoScenes([], 60_000)).toEqual([{ id: "s1", startMs: 0, endMs: 60_000 }]);
    const silent = autoScenes([], 300_000);
    expect(silent.length).toBeGreaterThan(3);
    expect(silent[silent.length - 1]!.endMs).toBe(300_000);
  });
});

describe("subtitles", () => {
  const srt = `1
00:00:01,200 --> 00:00:03,900
[r1] Мы оба знаем, чья это миска. (уверенно)

2
00:00:04,300 --> 00:00:06,100
[Пёс] Закон джунглей
на моей стороне.
`;
  it("parses SRT with role tags, role map and hints", () => {
    const lines = linesFromSrt(parseSrt(srt), { roleMap: { Пёс: "r2" } });
    expect(lines).toEqual([
      {
        id: "l1",
        role: "r1",
        startMs: 1200,
        endMs: 3900,
        text: { ru: "Мы оба знаем, чья это миска." },
        hint: "уверенно",
      },
      {
        id: "l2",
        role: "r2",
        startMs: 4300,
        endMs: 6100,
        text: { ru: "Закон джунглей на моей стороне." },
      },
    ]);
  });
  it("renders WebVTT with voice spans", () => {
    const vtt = toVtt(good(), "ru");
    expect(vtt).toMatch(/^WEBVTT/);
    expect(vtt).toContain("00:00:01.200 --> 00:00:03.900");
    expect(vtt).toContain("<v Кот>Мы оба знаем");
  });
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("build pipeline (ffmpeg)", () => {
  let dir = "";
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("synthesizes a source and builds a hashed package", async () => {
    dir = await mkdtemp(join(tmpdir(), "dubroom-clip-"));
    const m = good();
    const { video, bed } = await synthesizeSource(m, dir, { background: "color" });
    const out = join(dir, "dist");
    const r = await buildPackage({ manifest: m, video, bed, outDir: out, timeoutMs: 120_000 });

    const media = r.manifest.media!;
    expect(media.video.map((v) => `${v.height}:${v.codec.slice(0, 4)}`)).toEqual([
      "720:avc1",
      "480:avc1",
      "360:avc1",
      "480:vp9",
    ]);
    expect(media.bed.map((b) => b.codec)).toEqual(["opus", "mp4a.40.2"]);
    for (const url of [...media.video.map((v) => v.url), media.poster]) {
      expect(url).toMatch(/\.[0-9a-f]{8}\.\w+$/);
    }
    expect(Object.keys(r.manifest.checksums!.files)).toHaveLength(9);
    const written = JSON.parse(await readFile(join(out, "manifest.json"), "utf8")) as ClipManifest;
    expect(written.source).toBeUndefined();
    expect(written.durationMs).toBe(12_000);
    expect((await readdir(join(out, "video"))).length).toBe(4);

    const proxy = await buildProxy(video, join(dir, "proxy.webm"), {
      peaksFile: join(dir, "peaks.bin"),
    });
    expect(proxy.durationMs).toBe(12_000);
  }, 120_000);

  it("cuts scene media: on the keyframe grid by stream copy, elsewhere by re-encoding", async () => {
    const m = good();
    m.id = "c_scenes00001";
    m.lines[1] = { ...m.lines[1]!, startMs: 6_500, endMs: 8_100 };
    // s1 starts on the 2 s grid (stream copy), s2 at 5.9 s does not (re-encode)
    m.scenes = [
      { id: "s1", startMs: 0, endMs: 5_900 },
      { id: "s2", startMs: 5_900, endMs: 12_000 },
    ];
    const { video, bed } = await synthesizeSource(m, join(dir, "scenes-src"), {
      background: "color",
    });
    const out = join(dir, "scenes-dist");
    const r = await buildPackage({ manifest: m, video, bed, outDir: out, timeoutMs: 120_000 });
    const scenes = r.manifest.scenes!;
    expect(scenes.map((s) => s.id)).toEqual(["s1", "s2"]);
    for (const sc of scenes) {
      expect(sc.media!.video.map((v) => v.height)).toEqual([720, 480, 360, 480]);
      expect(sc.media!.bed).toHaveLength(2);
      const probed = JSON.parse(
        execFileSync("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "json",
          join(out, sc.media!.video[1]!.url),
        ]).toString(),
      ) as { format: { duration: string } };
      expect(
        Math.abs(Number(probed.format.duration) * 1000 - (sc.endMs - sc.startMs)),
      ).toBeLessThan(150);
    }
    expect(Object.keys(r.manifest.checksums!.files).some((f) => f.startsWith("scenes/s2/"))).toBe(
      true,
    );
  }, 180_000);
});

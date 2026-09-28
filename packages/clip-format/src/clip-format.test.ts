import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  emptyManifest,
  linesFromSrt,
  parseSrt,
  toVtt,
  validateManifest,
  type ClipManifest,
} from "./index.ts";
import { buildPackage, synthesizeSource } from "./node.ts";

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
    expect(media.video.map((v) => v.height)).toEqual([720, 480, 360]);
    expect(media.bed.map((b) => b.codec)).toEqual(["opus", "mp4a.40.2"]);
    for (const url of [...media.video.map((v) => v.url), media.poster]) {
      expect(url).toMatch(/\.[0-9a-f]{8}\.\w+$/);
    }
    expect(Object.keys(r.manifest.checksums!.files)).toHaveLength(8);
    const written = JSON.parse(await readFile(join(out, "manifest.json"), "utf8")) as ClipManifest;
    expect(written.source).toBeUndefined();
    expect(written.durationMs).toBe(12_000);
    expect((await readdir(join(out, "video"))).length).toBe(3);
  }, 120_000);
});

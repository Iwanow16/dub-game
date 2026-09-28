import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  ALLOWED_AUDIO_CODECS,
  ALLOWED_AUDIO_CONTAINERS,
  ALLOWED_CONTAINERS,
  ALLOWED_VIDEO_CODECS,
  MAX_SOURCE_DURATION_MS,
  MAX_SOURCE_HEIGHT,
  ffmpeg,
  probe,
  type ProbeResult,
} from "./ffmpeg.ts";
import type { ClipManifest, ClipMedia } from "./manifest.ts";
import { toVtt } from "./subtitles.ts";
import { validateManifest, type Issue } from "./validate.ts";

export interface BuildInput {
  manifest: ClipManifest;
  /** source video (required) */
  video: string;
  /** music+effects without voices; if missing, the video's own audio is used (with a warning) */
  bed?: string;
  /** isolated original dialogue (optional, for "before/after") */
  dialogue?: string;
  outDir: string;
  /** per-ffmpeg-call timeout */
  timeoutMs?: number;
  log?: (msg: string) => void;
  /** 0..1 */
  onProgress?: (p: number) => void;
}

export interface BuildResult {
  manifest: ClipManifest;
  warnings: Issue[];
}

export class BuildError extends Error {
  constructor(
    message: string,
    public readonly issues: Issue[] = [],
  ) {
    super(message);
  }
}

/** Quality ladder (§11.1). */
const LADDER = [
  {
    height: 720,
    crf: 23,
    maxrate: "1200k",
    bufsize: "2400k",
    profile: "high",
    codec: "avc1.64001f",
  },
  {
    height: 480,
    crf: 24,
    maxrate: "600k",
    bufsize: "1200k",
    profile: "main",
    codec: "avc1.4d401e",
  },
  {
    height: 360,
    crf: 26,
    maxrate: "320k",
    bufsize: "640k",
    profile: "baseline",
    codec: "avc1.42e01e",
  },
] as const;

function checkVideo(p: ProbeResult): Issue[] {
  const issues: Issue[] = [];
  if (!ALLOWED_CONTAINERS.includes(p.formatName)) {
    issues.push({
      code: "container",
      path: "source.video",
      message: `контейнер «${p.formatName}» не поддерживается (MP4/MOV/MKV)`,
    });
  }
  if (!p.video) {
    issues.push({ code: "no_video", path: "source.video", message: "в файле нет видеодорожки" });
    return issues;
  }
  if (!ALLOWED_VIDEO_CODECS.includes(p.video.codec)) {
    issues.push({
      code: "video_codec",
      path: "source.video",
      message: `видеокодек «${p.video.codec}» не поддерживается`,
    });
  }
  if (p.audio && !ALLOWED_AUDIO_CODECS.includes(p.audio.codec)) {
    issues.push({
      code: "audio_codec",
      path: "source.video",
      message: `аудиокодек «${p.audio.codec}» не поддерживается`,
    });
  }
  if (p.durationMs > MAX_SOURCE_DURATION_MS) {
    issues.push({
      code: "source_duration",
      path: "source.video",
      message: "исходник длиннее 10 минут",
    });
  }
  if (p.video.height > MAX_SOURCE_HEIGHT) {
    issues.push({ code: "resolution_max", path: "source.video", message: "разрешение больше 4K" });
  }
  if (p.video.height < 480) {
    issues.push({
      code: "resolution_min",
      path: "source.video",
      message: `разрешение исходника ${p.video.height}p, нужно ≥ 480p`,
    });
  }
  return issues;
}

async function checkAudio(file: string, field: string): Promise<Issue[]> {
  const p = await probe(file);
  const ok =
    ALLOWED_AUDIO_CONTAINERS.includes(p.formatName) &&
    p.audio &&
    ALLOWED_AUDIO_CODECS.includes(p.audio.codec);
  return ok
    ? []
    : [
        {
          code: "audio_format",
          path: field,
          message: `${basename(file)}: формат аудио не поддерживается`,
        },
      ];
}

async function hashName(
  dir: string,
  rel: string,
): Promise<{ url: string; bytes: number; sha: string }> {
  const abs = join(dir, rel);
  const buf = await readFile(abs);
  const sha = createHash("sha256").update(buf).digest("hex");
  const ext = extname(rel);
  const hashed = `${rel.slice(0, -ext.length)}.${sha.slice(0, 8)}${ext}`;
  await rename(abs, join(dir, hashed));
  return { url: hashed, bytes: (await stat(join(dir, hashed))).size, sha };
}

/** Mean volume (dBFS) of an interval, via volumedetect. */
async function meanVolume(file: string, startMs: number, endMs: number): Promise<number> {
  let mean = -91;
  await ffmpeg(
    [
      "-ss",
      String(startMs / 1000),
      "-to",
      String(endMs / 1000),
      "-i",
      file,
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    {
      timeoutMs: 60_000,
      onStderr: (l) => {
        const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(l);
        if (m) mean = Number(m[1]);
      },
    },
  );
  return mean;
}

/**
 * Turns a source clip into a publishable package (§8.1, §11.1): video ladder without audio,
 * loudness-normalized bed in Opus + AAC, poster, 3-second preview, VTT subtitles, content-hashed
 * file names and checksums. Runs the media-level quality checks from §9.3.
 */
export async function buildPackage(input: BuildInput): Promise<BuildResult> {
  const log = input.log ?? (() => {});
  const progress = input.onProgress ?? (() => {});
  const t = { timeoutMs: input.timeoutMs ?? 10 * 60_000 };
  const warnings: Issue[] = [];
  const m: ClipManifest = structuredClone(input.manifest);

  // 1. inspect untrusted inputs against whitelists
  log("probe source");
  const src = await probe(input.video);
  const srcIssues = checkVideo(src);
  if (input.bed) srcIssues.push(...(await checkAudio(input.bed, "source.bed")));
  if (input.dialogue) srcIssues.push(...(await checkAudio(input.dialogue, "source.dialogue")));
  if (srcIssues.length) throw new BuildError("исходные файлы не прошли проверку", srcIssues);

  const trimStart = m.source?.trimStartMs ?? 0;
  const trimEnd = Math.min(m.source?.trimEndMs ?? src.durationMs, src.durationMs);
  m.durationMs = trimEnd - trimStart;
  const pre = validateManifest(m);
  if (!pre.ok) throw new BuildError("манифест не прошёл проверку", pre.errors);
  warnings.push(...pre.warnings);

  const trim = ["-ss", (trimStart / 1000).toFixed(3), "-t", (m.durationMs / 1000).toFixed(3)];
  const out = input.outDir;
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, "video"), { recursive: true });
  await mkdir(join(out, "audio"), { recursive: true });
  await mkdir(join(out, "subtitles"), { recursive: true });
  progress(0.05);

  // 2. video ladder (no audio — the bed travels separately)
  const video: ClipMedia["video"] = [];
  const rungs = LADDER.filter((r) => r.height <= Math.max(src.video!.height, 360));
  for (const [i, r] of rungs.entries()) {
    log(`transcode ${r.height}p`);
    const rel = `video/${r.height}p.mp4`;
    await ffmpeg(
      [
        ...trim,
        "-i",
        input.video,
        "-an",
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-vf",
        `scale=-2:${r.height}:flags=lanczos,fps=30,format=yuv420p`,
        "-c:v",
        "libx264",
        "-profile:v",
        r.profile,
        "-preset",
        "slow",
        "-crf",
        String(r.crf),
        "-maxrate",
        r.maxrate,
        "-bufsize",
        r.bufsize,
        "-g",
        "60",
        "-keyint_min",
        "60",
        "-sc_threshold",
        "0",
        "-movflags",
        "+faststart",
        join(out, rel),
      ],
      t,
    );
    const h = await hashName(out, rel);
    video.push({ height: r.height, codec: r.codec, url: h.url, bytes: h.bytes });
    progress(0.05 + (0.45 * (i + 1)) / rungs.length);
  }

  // 2a. royalty-free fallback for browsers without H.264 (open-source Chromium, some Linux
  // Firefox builds): one 480p VP9/WebM rung; clients pick by canPlayType.
  log("transcode 480p vp9");
  const vp9Height = Math.min(480, src.video!.height);
  await ffmpeg(
    [
      ...trim,
      "-i",
      input.video,
      "-an",
      "-sn",
      "-dn",
      "-map_metadata",
      "-1",
      "-vf",
      `scale=-2:${vp9Height}:flags=lanczos,fps=30,format=yuv420p`,
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "0",
      "-crf",
      "36",
      "-row-mt",
      "1",
      "-deadline",
      "good",
      "-cpu-used",
      "4",
      "-g",
      "60",
      join(out, "video/480p.vp9.webm"),
    ],
    t,
  );
  {
    const h = await hashName(out, "video/480p.vp9.webm");
    video.push({ height: vp9Height, codec: "vp9", url: h.url, bytes: h.bytes });
  }
  progress(0.55);

  // 3. bed: normalize to -23 LUFS (EBU R128), Opus + AAC fallback for old Safari
  log("bed audio");
  const bedSource = input.bed ?? (src.audio ? input.video : null);
  if (!input.bed) {
    warnings.push({
      code: src.audio ? "bed_from_video" : "bed_silent",
      path: "source.bed",
      message: src.audio
        ? "фон взят из аудио исходного видео — оригинальные голоса не удалены"
        : "в исходнике нет звука — фон будет тишиной",
    });
  }
  const bedWav = join(out, "audio", "bed.wav");
  if (bedSource) {
    const bedTrim = bedSource === input.video ? trim : ["-t", (m.durationMs / 1000).toFixed(3)];
    await ffmpeg(
      [
        ...bedTrim,
        "-i",
        bedSource,
        "-vn",
        "-af",
        "loudnorm=I=-23:TP=-2:LRA=11,aresample=48000",
        "-ac",
        "2",
        bedWav,
      ],
      t,
    );
  } else {
    await ffmpeg(
      [
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-t",
        String(m.durationMs / 1000),
        bedWav,
      ],
      t,
    );
  }
  await ffmpeg(
    ["-i", bedWav, "-c:a", "libopus", "-b:a", "96k", "-vbr", "on", join(out, "audio/bed.opus")],
    t,
  );
  await ffmpeg(
    [
      "-i",
      bedWav,
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      join(out, "audio/bed.m4a"),
    ],
    t,
  );
  progress(0.7);

  // 3a. residual voice heuristic (§9.3): bed noticeably louder inside lines than outside
  if (input.bed && m.lines.length) {
    for (const l of m.lines) {
      const inside = await meanVolume(bedWav, l.startMs, l.endMs);
      if (inside > -35) {
        const before = await meanVolume(bedWav, Math.max(0, l.startMs - 1500), l.startMs);
        if (inside - before > 6) {
          warnings.push({
            code: "residual_voice",
            path: `lines.${l.id}`,
            message: `возможно, голос не до конца удалён из фона на ${(l.startMs / 1000).toFixed(1)}–${(l.endMs / 1000).toFixed(1)} с`,
          });
        }
      }
    }
  }
  await rm(bedWav);

  const bed = [
    { codec: "opus", ...(await hashName(out, "audio/bed.opus")) },
    { codec: "mp4a.40.2", ...(await hashName(out, "audio/bed.m4a")) },
  ].map(({ codec, url, bytes }) => ({ codec, url, bytes }));

  let originalVoice: ClipMedia["originalVoice"];
  if (input.dialogue) {
    log("original voice");
    await ffmpeg(
      [
        "-t",
        (m.durationMs / 1000).toFixed(3),
        "-i",
        input.dialogue,
        "-vn",
        "-ac",
        "1",
        "-c:a",
        "libopus",
        "-b:a",
        "48k",
        join(out, "audio/original_voice.opus"),
      ],
      t,
    );
    const h = await hashName(out, "audio/original_voice.opus");
    originalVoice = { codec: "opus", url: h.url, bytes: h.bytes };
  }
  progress(0.8);

  // 4. black screen check (§9.3): no black segment longer than 2 s
  const black: string[] = [];
  await ffmpeg(
    [...trim, "-i", input.video, "-an", "-vf", "blackdetect=d=2:pix_th=0.10", "-f", "null", "-"],
    {
      ...t,
      onStderr: (l) => {
        const b = /black_start:([\d.]+) black_end:([\d.]+)/.exec(l);
        if (b) black.push(`${Number(b[1]).toFixed(1)}–${Number(b[2]).toFixed(1)} с`);
      },
    },
  );
  for (const seg of black) {
    warnings.push({
      code: "black_screen",
      path: "source.video",
      message: `чёрный экран дольше 2 с: ${seg}`,
    });
  }

  // 5. poster + preview (§8.1)
  log("poster & preview");
  const posterAt = Math.min(1, m.durationMs / 2000);
  await ffmpeg(
    [
      "-ss",
      (trimStart / 1000 + posterAt).toFixed(3),
      "-i",
      input.video,
      "-frames:v",
      "1",
      "-vf",
      "scale=640:-2",
      "-c:v",
      "libwebp",
      "-quality",
      "80",
      join(out, "poster.webp"),
    ],
    t,
  );
  const previewStart = trimStart / 1000 + Math.max(0, (m.durationMs / 1000) * 0.2);
  await ffmpeg(
    [
      "-ss",
      previewStart.toFixed(3),
      "-t",
      "3",
      "-i",
      input.video,
      "-an",
      "-vf",
      "scale=-2:180,fps=15",
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "250k",
      "-deadline",
      "good",
      "-cpu-used",
      "4",
      join(out, "preview.webm"),
    ],
    t,
  );
  const poster = await hashName(out, "poster.webp");
  const preview = await hashName(out, "preview.webm");
  progress(0.9);

  // 6. subtitles for every language that has text
  const subtitles: Record<string, string> = {};
  for (const lang of ["ru", "en"] as const) {
    if (m.lines.some((l) => l.text[lang])) {
      await writeFile(join(out, `subtitles/${lang}.vtt`), toVtt(m, lang));
      subtitles[lang] = (await hashName(out, `subtitles/${lang}.vtt`)).url;
    }
  }

  // 7. manifest with media block + checksums
  const files: Record<string, string> = {};
  for (const rel of [
    ...video.map((v) => v.url),
    ...bed.map((b) => b.url),
    ...(originalVoice ? [originalVoice.url] : []),
    poster.url,
    preview.url,
    ...Object.values(subtitles),
  ]) {
    files[rel] = createHash("sha256")
      .update(await readFile(join(out, rel)))
      .digest("hex");
  }
  m.media = { video, bed, originalVoice, poster: poster.url, preview: preview.url, subtitles };
  m.checksums = { algo: "sha256", files };
  delete m.source;
  const final = validateManifest(m, { requireMedia: true });
  if (!final.ok) throw new BuildError("итоговый манифест невалиден", final.errors);
  await writeFile(join(out, "manifest.json"), JSON.stringify(m, null, 2));
  progress(1);
  log("done");
  return { manifest: m, warnings };
}

/**
 * Editing proxy for Clip Studio: authors' sources (HEVC .mov from phones, MKV, 4K) often don't play
 * in a browser. The worker makes a small VP9/Opus WebM that every modern browser decodes, and
 * reports the exact duration.
 */
export async function buildProxy(
  video: string,
  outFile: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ durationMs: number; height: number }> {
  const src = await probe(video);
  const issues = checkVideo(src).filter((i) => i.code !== "resolution_min");
  if (issues.length) throw new BuildError("исходник не прошёл проверку", issues);
  await ffmpeg(
    [
      "-i",
      video,
      "-sn",
      "-dn",
      "-map_metadata",
      "-1",
      "-vf",
      "scale=-2:'min(480,ih)':flags=bilinear,fps=30,format=yuv420p",
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "0",
      "-crf",
      "40",
      "-row-mt",
      "1",
      "-deadline",
      "realtime",
      "-cpu-used",
      "8",
      "-c:a",
      "libopus",
      "-b:a",
      "64k",
      "-ac",
      "1",
      outFile,
    ],
    { timeoutMs: opts.timeoutMs ?? 10 * 60_000 },
  );
  return { durationMs: src.durationMs, height: src.video!.height };
}

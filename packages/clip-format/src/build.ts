import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  ALLOWED_AUDIO_CODECS,
  ALLOWED_AUDIO_CONTAINERS,
  ALLOWED_CONTAINERS,
  ALLOWED_VIDEO_CODECS,
  FFMPEG,
  MAX_SOURCE_HEIGHT,
  ffmpeg,
  probe,
  type ProbeResult,
} from "./ffmpeg.ts";
import type { ClipManifest, ClipMedia, ClipScene, SceneMedia } from "./manifest.ts";
import { SCENE_LIMITS, autoScenes } from "./scenes.ts";
import { toVtt } from "./subtitles.ts";
import { LIMITS, validateManifest, type Issue } from "./validate.ts";

export interface BuildInput {
  manifest: ClipManifest;
  /** source video (required) */
  video: string;
  /** music+effects without voices; if missing, the video's own audio is used (with a warning) */
  bed?: string;
  /** isolated original dialogue (optional, for "before/after") */
  dialogue?: string;
  outDir: string;
  /** base per-ffmpeg-call timeout; grows with the clip length (encodes run ~real time or faster) */
  timeoutMs?: number;
  /** longest allowed clip after trimming (CLIP_MAX_MINUTES) */
  maxDurationMs?: number;
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

/** Keyframe every 2 s at 30 fps, never elsewhere — scene cuts on this grid need no re-encode. */
const GOP = [
  "-g",
  "60",
  "-keyint_min",
  "60",
  "-sc_threshold",
  "0",
  "-force_key_frames",
  "expr:gte(t,n_forced*2)",
];

/** Slower presets compress better; long clips would take hours with them. */
function x264Preset(durationMs: number): string {
  if (durationMs <= 2 * 60_000) return "slow";
  if (durationMs <= 20 * 60_000) return "medium";
  return "veryfast";
}

const sec = (ms: number) => (ms / 1000).toFixed(3);

function checkVideo(p: ProbeResult, maxSourceMs: number): Issue[] {
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
  if (p.durationMs > maxSourceMs) {
    issues.push({
      code: "source_duration",
      path: "source.video",
      message: `исходник длиннее ${Math.round(maxSourceMs / 60_000)} мин — обрежьте его или увеличьте CLIP_MAX_MINUTES`,
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

/**
 * Loudness timeline in one decoding pass: RMS level (dBFS) per 100 ms window. Replaces one ffmpeg
 * call per line, which doesn't scale to an hour-long episode with hundreds of lines.
 */
export async function rmsTimeline(file: string, timeoutMs: number): Promise<Float32Array> {
  const pcm = await pcmMono(file, 8000, timeoutMs);
  const win = 800; // 100 ms at 8 kHz
  const out = new Float32Array(Math.ceil(pcm.length / win));
  for (let w = 0; w < out.length; w++) {
    let sum = 0;
    const end = Math.min(pcm.length, (w + 1) * win);
    for (let i = w * win; i < end; i++) sum += (pcm[i]! / 32768) ** 2;
    const rms = Math.sqrt(sum / Math.max(1, end - w * win));
    out[w] = rms > 0 ? 20 * Math.log10(rms) : -91;
  }
  return out;
}

/** Decodes audio to mono signed 16-bit PCM at a low rate (analysis and waveform only). */
function pcmMono(file: string, rate: number, timeoutMs: number): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      FFMPEG,
      [
        "-hide_banner",
        "-nostdin",
        "-i",
        file,
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(rate),
        "-f",
        "s16le",
        "-",
      ],
      {
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg pcm exited with ${code}`));
      const buf = Buffer.concat(chunks);
      resolve(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)));
    });
  });
}

const meanDb = (tl: Float32Array, fromMs: number, toMs: number) => {
  const a = Math.max(0, Math.floor(fromMs / 100));
  const b = Math.min(tl.length, Math.max(a + 1, Math.ceil(toMs / 100)));
  let sum = 0;
  for (let i = a; i < b; i++) sum += 10 ** (tl[i]! / 10);
  return b > a ? 10 * Math.log10(sum / (b - a) || 1e-10) : -91;
};

/**
 * Turns a source clip into a publishable package (§8.1, §11.1): video ladder without audio,
 * loudness-normalized bed in Opus + AAC, poster, 3-second preview, VTT subtitles, content-hashed
 * file names and checksums; long clips also get scenes with their own small media (ADR-0009).
 * Runs the media-level quality checks from §9.3.
 */
export async function buildPackage(input: BuildInput): Promise<BuildResult> {
  const log = input.log ?? (() => {});
  const progress = input.onProgress ?? (() => {});
  const maxDuration = input.maxDurationMs ?? LIMITS.maxDurationMs;
  const warnings: Issue[] = [];
  const m: ClipManifest = structuredClone(input.manifest);

  // 1. inspect untrusted inputs against whitelists
  log("probe source");
  const src = await probe(input.video);
  const srcIssues = checkVideo(src, maxDuration * 2);
  if (input.bed) srcIssues.push(...(await checkAudio(input.bed, "source.bed")));
  if (input.dialogue) srcIssues.push(...(await checkAudio(input.dialogue, "source.dialogue")));
  if (srcIssues.length) throw new BuildError("исходные файлы не прошли проверку", srcIssues);

  const trimStart = m.source?.trimStartMs ?? 0;
  const trimEnd = Math.min(m.source?.trimEndMs ?? src.durationMs, src.durationMs);
  m.durationMs = trimEnd - trimStart;

  // long clips without author-defined scenes are split automatically
  const autoSplit = !m.scenes?.length && m.durationMs > SCENE_LIMITS.autoAboveMs;
  if (autoSplit) m.scenes = autoScenes(m.lines, m.durationMs);

  const pre = validateManifest(m, { maxDurationMs: maxDuration });
  if (!pre.ok) throw new BuildError("манифест не прошёл проверку", pre.errors);
  warnings.push(...pre.warnings.filter((w) => w.code !== "scenes_auto"));
  if (autoSplit) {
    warnings.push({
      code: "scenes_auto",
      path: "scenes",
      message: `клип разбит на ${m.scenes!.length} сцен автоматически — проверьте границы в Studio`,
    });
  }

  // encodes take about real time on a small server; give every call generous headroom
  const t = { timeoutMs: (input.timeoutMs ?? 10 * 60_000) + m.durationMs * 6 };
  const preset = x264Preset(m.durationMs);
  const trim = ["-ss", sec(trimStart), "-t", sec(m.durationMs)];
  const out = input.outDir;
  await rm(out, { recursive: true, force: true });
  for (const d of ["video", "audio", "subtitles"]) await mkdir(join(out, d), { recursive: true });
  progress(0.05);

  // 2. video ladder (no audio — the bed travels separately)
  const video: ClipMedia["video"] = [];
  const rungs = LADDER.filter((r) => r.height <= Math.max(src.video!.height, 360));
  const rungFiles: { height: number; codec: string; file: string; ext: string }[] = [];
  for (const [i, r] of rungs.entries()) {
    log(`transcode ${r.height}p (${preset})`);
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
        preset,
        "-crf",
        String(r.crf),
        "-maxrate",
        r.maxrate,
        "-bufsize",
        r.bufsize,
        ...GOP,
        "-movflags",
        "+faststart",
        join(out, rel),
      ],
      t,
    );
    rungFiles.push({ height: r.height, codec: r.codec, file: join(out, rel), ext: "mp4" });
    progress(0.05 + (0.4 * (i + 1)) / rungs.length);
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
      // fallback rung only: long clips use the realtime encoder, or it outlasts the whole ladder
      "-deadline",
      m.durationMs > 2 * 60_000 ? "realtime" : "good",
      "-cpu-used",
      m.durationMs > 2 * 60_000 ? "8" : "4",
      ...GOP,
      join(out, "video/480p.vp9.webm"),
    ],
    t,
  );
  rungFiles.push({
    height: vp9Height,
    codec: "vp9",
    file: join(out, "video/480p.vp9.webm"),
    ext: "webm",
  });
  progress(0.5);

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
    const bedTrim = bedSource === input.video ? trim : ["-t", sec(m.durationMs)];
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
      ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", sec(m.durationMs), bedWav],
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
  progress(0.6);

  // 3a. residual voice heuristic (§9.3): bed noticeably louder inside lines than just before them
  if (input.bed && m.lines.length) {
    const tl = await rmsTimeline(bedWav, t.timeoutMs);
    let flagged = 0;
    for (const l of m.lines) {
      const inside = meanDb(tl, l.startMs, l.endMs);
      if (inside > -35 && inside - meanDb(tl, Math.max(0, l.startMs - 1500), l.startMs) > 6) {
        if (++flagged <= 20) {
          warnings.push({
            code: "residual_voice",
            path: `lines.${l.id}`,
            message: `возможно, голос не до конца удалён из фона на ${(l.startMs / 1000).toFixed(1)}–${(l.endMs / 1000).toFixed(1)} с`,
          });
        }
      }
    }
    if (flagged > 20) {
      warnings.push({
        code: "residual_voice",
        path: "lines",
        message: `и ещё ${flagged - 20} похожих мест`,
      });
    }
  }

  let originalVoice: ClipMedia["originalVoice"];
  if (input.dialogue) {
    log("original voice");
    await ffmpeg(
      [
        "-t",
        sec(m.durationMs),
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
  progress(0.65);

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
  for (const seg of black.slice(0, 20)) {
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
      sec(trimStart + posterAt * 1000),
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
  const previewStart = trimStart + m.durationMs * 0.2;
  await ffmpeg(
    [
      "-ss",
      sec(previewStart),
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
  progress(0.7);

  // 6. scenes: small preloadable media per scene, cut from the ladder (ADR-0009)
  const sceneFiles: string[] = [];
  if (m.scenes?.length) {
    const scenes: ClipScene[] = [];
    for (const [i, sc] of m.scenes.entries()) {
      log(`scene ${sc.id} (${i + 1}/${m.scenes.length})`);
      const media = await buildScene(out, sc, rungFiles, bedWav, input.video, trimStart, t);
      sceneFiles.push(
        ...media.video.map((v) => v.url),
        ...media.bed.map((b) => b.url),
        media.poster,
      );
      scenes.push({ ...sc, media });
      progress(0.7 + (0.25 * (i + 1)) / m.scenes.length);
    }
    m.scenes = scenes;
  }
  await rm(bedWav);

  // hash the full-clip files only now: scenes were cut from them under their plain names
  for (const r of rungFiles) {
    const h = await hashName(out, r.file.slice(out.length + 1));
    video.push({ height: r.height, codec: r.codec, url: h.url, bytes: h.bytes });
  }
  const bed = [
    { codec: "opus", ...(await hashName(out, "audio/bed.opus")) },
    { codec: "mp4a.40.2", ...(await hashName(out, "audio/bed.m4a")) },
  ].map(({ codec, url, bytes }) => ({ codec, url, bytes }));
  const poster = await hashName(out, "poster.webp");
  const preview = await hashName(out, "preview.webm");

  // 7. subtitles for every language that has text
  const subtitles: Record<string, string> = {};
  for (const lang of ["ru", "en"] as const) {
    if (m.lines.some((l) => l.text[lang])) {
      await writeFile(join(out, `subtitles/${lang}.vtt`), toVtt(m, lang));
      subtitles[lang] = (await hashName(out, `subtitles/${lang}.vtt`)).url;
    }
  }

  // 8. manifest with media block + checksums
  const files: Record<string, string> = {};
  for (const rel of [
    ...video.map((v) => v.url),
    ...bed.map((b) => b.url),
    ...(originalVoice ? [originalVoice.url] : []),
    poster.url,
    preview.url,
    ...Object.values(subtitles),
    ...sceneFiles,
  ]) {
    files[rel] = createHash("sha256")
      .update(await readFile(join(out, rel)))
      .digest("hex");
  }
  m.media = { video, bed, originalVoice, poster: poster.url, preview: preview.url, subtitles };
  m.checksums = { algo: "sha256", files };
  delete m.source;
  const final = validateManifest(m, { requireMedia: true, maxDurationMs: maxDuration });
  if (!final.ok) throw new BuildError("итоговый манифест невалиден", final.errors);
  await writeFile(join(out, "manifest.json"), JSON.stringify(m, null, 2));
  progress(1);
  log("done");
  return { manifest: m, warnings };
}

/**
 * One scene's media. Starts on the 2 s keyframe grid are cut by stream copy (fast, lossless);
 * other starts are re-encoded from the source so the first frame is exact.
 */
async function buildScene(
  out: string,
  sc: Pick<ClipScene, "id" | "startMs" | "endMs">,
  rungs: { height: number; codec: string; file: string; ext: string }[],
  bedWav: string,
  source: string,
  trimStart: number,
  t: { timeoutMs: number },
): Promise<SceneMedia> {
  const dir = `scenes/${sc.id}`;
  await mkdir(join(out, dir), { recursive: true });
  const len = sc.endMs - sc.startMs;
  const onGrid = sc.startMs % SCENE_LIMITS.gridMs === 0;
  const video: SceneMedia["video"] = [];
  for (const r of rungs) {
    const rel = `${dir}/${r.height}p${r.codec === "vp9" ? ".vp9" : ""}.${r.ext}`;
    if (onGrid) {
      await ffmpeg(
        [
          "-ss",
          sec(sc.startMs),
          "-i",
          r.file,
          "-t",
          sec(len),
          "-c",
          "copy",
          "-avoid_negative_ts",
          "make_zero",
          ...(r.ext === "mp4" ? ["-movflags", "+faststart"] : []),
          join(out, rel),
        ],
        t,
      );
    } else {
      const codec =
        r.codec === "vp9"
          ? [
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
            ]
          : ["-c:v", "libx264", "-preset", "medium", "-crf", "23", "-movflags", "+faststart"];
      await ffmpeg(
        [
          "-ss",
          sec(trimStart + sc.startMs),
          "-t",
          sec(len),
          "-i",
          source,
          "-an",
          "-sn",
          "-dn",
          "-map_metadata",
          "-1",
          "-vf",
          `scale=-2:${r.height}:flags=lanczos,fps=30,format=yuv420p`,
          ...codec,
          ...GOP,
          join(out, rel),
        ],
        t,
      );
    }
    const h = await hashName(out, rel);
    video.push({ height: r.height, codec: r.codec, url: h.url, bytes: h.bytes });
  }
  const bedCut = ["-ss", sec(sc.startMs), "-t", sec(len), "-i", bedWav];
  await ffmpeg(
    [...bedCut, "-c:a", "libopus", "-b:a", "96k", "-vbr", "on", join(out, `${dir}/bed.opus`)],
    t,
  );
  await ffmpeg(
    [
      ...bedCut,
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      join(out, `${dir}/bed.m4a`),
    ],
    t,
  );
  const bed = [
    { codec: "opus", ...(await hashName(out, `${dir}/bed.opus`)) },
    { codec: "mp4a.40.2", ...(await hashName(out, `${dir}/bed.m4a`)) },
  ].map(({ codec, url, bytes }) => ({ codec, url, bytes }));
  const posterAt = sc.startMs + Math.min(1000, len / 2);
  const ref = rungs[0]!;
  await ffmpeg(
    [
      "-ss",
      sec(posterAt),
      "-i",
      ref.file,
      "-frames:v",
      "1",
      "-vf",
      "scale=640:-2",
      "-c:v",
      "libwebp",
      "-quality",
      "80",
      join(out, `${dir}/poster.webp`),
    ],
    t,
  );
  const poster = await hashName(out, `${dir}/poster.webp`);
  return { video, bed, poster: poster.url };
}

/**
 * Editing proxy for Clip Studio: authors' sources (HEVC .mov from phones, MKV, 4K, hour-long
 * episodes) often don't play in a browser, and a long one can't be loaded whole. The worker makes a
 * small VP9/Opus WebM that every modern browser streams, a compact waveform (peaks, 100 per
 * second) and reports the exact duration.
 */
export async function buildProxy(
  video: string,
  outFile: string,
  opts: { timeoutMs?: number; maxDurationMs?: number; peaksFile?: string } = {},
): Promise<{ durationMs: number; height: number }> {
  const src = await probe(video);
  const issues = checkVideo(src, (opts.maxDurationMs ?? LIMITS.maxDurationMs) * 2).filter(
    (i) => i.code !== "resolution_min",
  );
  if (issues.length) throw new BuildError("исходник не прошёл проверку", issues);
  const timeoutMs = (opts.timeoutMs ?? 10 * 60_000) + src.durationMs * 4;
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
      "-g",
      "60",
      "-c:a",
      "libopus",
      "-b:a",
      "64k",
      "-ac",
      "1",
      outFile,
    ],
    { timeoutMs },
  );
  if (opts.peaksFile) {
    await writeFile(
      opts.peaksFile,
      src.audio ? await wavePeaks(video, timeoutMs) : new Uint8Array(0),
    );
  }
  return { durationMs: src.durationMs, height: src.video!.height };
}

/**
 * Waveform for Studio: for every 10 ms one byte pair (min, max) as signed 8-bit samples.
 * An hour is ~720 KB — cheap to download, no need to decode the audio in the browser.
 */
export async function wavePeaks(file: string, timeoutMs: number): Promise<Uint8Array> {
  const pcm = await pcmMono(file, 8000, timeoutMs);
  const win = 80; // 10 ms at 8 kHz
  const n = Math.ceil(pcm.length / win);
  const out = new Int8Array(n * 2);
  for (let w = 0; w < n; w++) {
    let min = 0;
    let max = 0;
    for (let i = w * win; i < Math.min(pcm.length, (w + 1) * win); i++) {
      const v = pcm[i]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out[w * 2] = Math.round(min / 256);
    out[w * 2 + 1] = Math.round(max / 256);
  }
  return new Uint8Array(out.buffer);
}

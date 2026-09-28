import { spawn } from "node:child_process";

export class ProcessError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
  ) {
    super(message);
  }
}

export interface RunOptions {
  timeoutMs?: number;
  /** receives stderr lines, e.g. for progress parsing */
  onStderr?: (line: string) => void;
}

/** Runs a binary without a shell, with a hard timeout (§22.6). */
export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => {
        child.kill("SIGKILL");
        reject(new ProcessError(`${bin} timed out after ${opts.timeoutMs} ms`, stderr));
      },
      opts.timeoutMs ?? 10 * 60_000,
    );
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr = (stderr + s).slice(-20_000);
      if (opts.onStderr) s.split(/\r|\n/).forEach((l) => l && opts.onStderr!(l));
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ProcessError(`${bin}: ${e.message}`, stderr));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new ProcessError(`${bin} exited with ${code}: ${stderr.slice(-800)}`, stderr));
    });
  });
}

export const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

export function ffmpeg(args: string[], opts?: RunOptions) {
  return run(FFMPEG, ["-hide_banner", "-nostdin", "-y", ...args], opts);
}

export interface ProbeResult {
  formatName: string;
  durationMs: number;
  video: { codec: string; width: number; height: number; fps: number } | null;
  audio: { codec: string; sampleRate: number; channels: number } | null;
}

interface FfprobeJson {
  format?: { format_name?: string; duration?: string };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    sample_rate?: string;
    channels?: number;
  }[];
}

export async function probe(file: string): Promise<ProbeResult> {
  const out = await run(
    FFPROBE,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { timeoutMs: 30_000 },
  );
  const j = JSON.parse(out) as FfprobeJson;
  const v = j.streams?.find((s) => s.codec_type === "video");
  const a = j.streams?.find((s) => s.codec_type === "audio");
  const fps = (() => {
    const [n, d] = (v?.avg_frame_rate ?? "0/1").split("/").map(Number);
    return d ? n! / d : 0;
  })();
  return {
    formatName: j.format?.format_name ?? "",
    durationMs: Math.round(Number(j.format?.duration ?? 0) * 1000),
    video: v
      ? { codec: v.codec_name ?? "", width: v.width ?? 0, height: v.height ?? 0, fps }
      : null,
    audio: a
      ? {
          codec: a.codec_name ?? "",
          sampleRate: Number(a.sample_rate ?? 0),
          channels: a.channels ?? 0,
        }
      : null,
  };
}

/** Whitelists for untrusted uploads (§22.6). */
export const ALLOWED_CONTAINERS = ["mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm"];
export const ALLOWED_VIDEO_CODECS = ["h264", "hevc", "vp9", "av1", "vp8", "mpeg4"];
export const ALLOWED_AUDIO_CODECS = [
  "aac",
  "opus",
  "vorbis",
  "mp3",
  "flac",
  "pcm_s16le",
  "pcm_s24le",
  "pcm_f32le",
];
export const ALLOWED_AUDIO_CONTAINERS = [
  "wav",
  "ogg",
  "flac",
  "mp3",
  "mov,mp4,m4a,3gp,3g2,mj2",
  "matroska,webm",
];
export const MAX_SOURCE_DURATION_MS = 10 * 60_000;
export const MAX_SOURCE_HEIGHT = 2160;

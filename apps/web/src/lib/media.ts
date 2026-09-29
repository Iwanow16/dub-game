import { STREAM_THRESHOLD_MS, type CatalogEntry } from "@dubroom/shared";
import { decode } from "@dubroom/audio";
import { audioContext } from "./audio.ts";
import { usePrefs } from "./prefs.ts";

/** Published manifest as the client needs it (§8.2). */
export interface Manifest {
  id: string;
  version: number;
  title: { ru?: string; en?: string };
  durationMs: number;
  roles: { id: string; name: { ru?: string; en?: string }; color: string }[];
  lines: {
    id: string;
    role: string;
    startMs: number;
    endMs: number;
    text: { ru?: string; en?: string };
    hint?: string;
  }[];
  media: {
    video: { height: number; codec: string; url: string; bytes: number }[];
    bed: { codec: string; url: string; bytes: number }[];
    poster: string;
    preview: string | null;
  };
  sync: { leadInMs: number; videoAudioOffsetMs: number };
  scenes?: {
    id: string;
    startMs: number;
    endMs: number;
    title?: { ru?: string; en?: string };
    media?: {
      video: { height: number; codec: string; url: string; bytes: number }[];
      bed: { codec: string; url: string; bytes: number }[];
      poster: string;
    };
  }[];
}

/**
 * A clip ready to play. Short clips and scenes are preloaded (video blob + decoded bed); long clips
 * played whole are streamed from their URLs (ADR-0009) — nothing long is decoded into memory.
 */
export interface LoadedClip {
  /** manifest of what is played: for a scene, lines are re-timed and durationMs is the scene's */
  manifest: Manifest;
  base: string;
  streaming: boolean;
  videoUrl: string;
  videoHeight: number;
  /** preloaded mode */
  bed: AudioBuffer | null;
  /** streaming mode */
  bedUrl: string | null;
  posterUrl: string;
}

/** What loadClip needs from a catalog entry / playable. */
export interface ClipRef {
  manifestUrl: string;
  scene?: { id: string } | null;
}

const manifests = new Map<string, Promise<Manifest>>();
const clips = new Map<string, Promise<LoadedClip>>();
const dubs = new Map<string, Promise<AudioBuffer>>();

/** Measured download speed (bytes/s) from previous fetches, for quality choice (§11.4). */
let measuredBps: number | null = null;

function baseOf(manifestUrl: string) {
  return manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1);
}

export function loadManifest(manifestUrl: string): Promise<Manifest> {
  let p = manifests.get(manifestUrl);
  if (!p) {
    p = fetch(manifestUrl).then((r) => {
      if (!r.ok) throw new Error(`manifest ${r.status}`);
      return r.json() as Promise<Manifest>;
    });
    p.catch(() => manifests.delete(manifestUrl));
    manifests.set(manifestUrl, p);
  }
  return p;
}

/**
 * Quality rule (§11.4): the best rung that downloads within half of the pick phase (~10 s),
 * `saveData` → lowest, manual override in settings.
 */
export function videoMime(v: { codec: string; url: string }): string {
  return v.url.endsWith(".webm")
    ? `video/webm; codecs="${v.codec}"`
    : `video/mp4; codecs="${v.codec}"`;
}

let probeEl: HTMLVideoElement | null = null;
/** Rungs this browser can decode; H.264 first (hardware decoding), VP9 WebM as the fallback. */
export function playableRungs(m: Manifest): Manifest["media"]["video"] {
  probeEl ??= document.createElement("video");
  const ok = m.media.video.filter((v) => probeEl!.canPlayType(videoMime(v)) !== "");
  const h264 = ok.filter((v) => v.codec.startsWith("avc1"));
  return h264.length ? h264 : ok.length ? ok : m.media.video;
}

export function chooseVideo(m: Manifest, streaming = false): Manifest["media"]["video"][number] {
  const ladder = [...playableRungs(m)].sort((a, b) => b.height - a.height);
  const pref = usePrefs.getState().quality;
  if (pref !== "auto") return ladder.find((v) => v.height <= pref) ?? ladder[ladder.length - 1]!;
  const conn = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string; downlink?: number };
    }
  ).connection;
  if (conn?.saveData) return ladder[ladder.length - 1]!;
  const bps =
    measuredBps ??
    (conn?.downlink
      ? (conn.downlink * 1_000_000) / 8
      : conn?.effectiveType === "3g"
        ? 90_000
        : 600_000);
  if (streaming) {
    // streamed: the rung's bitrate must fit comfortably into the connection
    const seconds = Math.max(1, m.durationMs / 1000);
    return ladder.find((v) => v.bytes / seconds <= bps * 0.6) ?? ladder[ladder.length - 1]!;
  }
  const budgetS = 10;
  return ladder.find((v) => v.bytes / bps <= budgetS) ?? ladder[ladder.length - 1]!;
}

function chooseBed(m: Manifest) {
  const a = document.createElement("audio");
  const opus = m.media.bed.find((b) => b.codec === "opus");
  if (opus && a.canPlayType('audio/ogg; codecs="opus"')) return opus;
  return m.media.bed.find((b) => b.codec.startsWith("mp4a")) ?? m.media.bed[0]!;
}

async function fetchBlob(url: string, onProgress?: (p: number) => void): Promise<Blob> {
  const t0 = performance.now();
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const reader = res.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value as Uint8Array<ArrayBuffer>);
    got += value.length;
    if (total) onProgress?.(got / total);
  }
  const secs = (performance.now() - t0) / 1000;
  if (got > 200_000 && secs > 0.05) measuredBps = got / secs;
  return new Blob(parts, { type: res.headers.get("content-type") ?? "" });
}

/**
 * Full load of the chosen clip before rehearsal (§11.3 step 4): the whole video as a blob URL
 * (instant seeks, no mid-take buffering) and the bed decoded for sample-accurate playback.
 */
export function loadClip(entry: ClipRef, onProgress?: (p: number) => void): Promise<LoadedClip> {
  const key = `${entry.manifestUrl}#${entry.scene?.id ?? ""}`;
  let p = clips.get(key);
  if (!p) {
    p = (async () => {
      const full = await loadManifest(entry.manifestUrl);
      const base = baseOf(entry.manifestUrl);
      const manifest = entry.scene ? sceneManifest(full, entry.scene.id) : full;
      if (!entry.scene && full.durationMs > STREAM_THRESHOLD_MS) {
        // long clip played whole: stream it (range requests, faststart MP4)
        const video = chooseVideo(manifest, true);
        onProgress?.(1);
        return {
          manifest,
          base,
          streaming: true,
          videoUrl: base + video.url,
          videoHeight: video.height,
          bed: null,
          bedUrl: base + chooseBed(manifest).url,
          posterUrl: base + manifest.media.poster,
        };
      }
      const video = chooseVideo(manifest);
      const bed = chooseBed(manifest);
      let vp = 0;
      let bp = 0;
      const report = () => onProgress?.(vp * 0.85 + bp * 0.15);
      const [videoBlob, bedBlob] = await Promise.all([
        fetchBlob(base + video.url, (x) => ((vp = x), report())),
        fetchBlob(base + bed.url, (x) => ((bp = x), report())),
      ]);
      let bedBuf: AudioBuffer | null = null;
      try {
        bedBuf = await decode(audioContext(), bedBlob);
      } catch {
        // try the other codec (e.g. Safari without Opus)
        const other = manifest.media.bed.find((b) => b.url !== bed.url);
        if (other)
          bedBuf = await decode(audioContext(), await fetchBlob(base + other.url)).catch(
            () => null,
          );
      }
      onProgress?.(1);
      return {
        manifest,
        base,
        streaming: false,
        videoUrl: URL.createObjectURL(videoBlob),
        videoHeight: video.height,
        bed: bedBuf,
        bedUrl: null,
        posterUrl: base + manifest.media.poster,
      };
    })();
    p.catch(() => clips.delete(key));
    clips.set(key, p);
  }
  return p;
}

/** The manifest of one scene: its own media, lines re-timed from the scene start. */
export function sceneManifest(m: Manifest, sceneId: string): Manifest {
  const sc = m.scenes?.find((x) => x.id === sceneId);
  if (!sc?.media) throw new Error(`scene ${sceneId} not found`);
  return {
    ...m,
    durationMs: sc.endMs - sc.startMs,
    lines: m.lines
      .filter((l) => l.startMs >= sc.startMs && l.endMs <= sc.endMs)
      .map((l) => ({ ...l, startMs: l.startMs - sc.startMs, endMs: l.endMs - sc.startMs })),
    media: { video: sc.media.video, bed: sc.media.bed, poster: sc.media.poster, preview: null },
    scenes: undefined,
  };
}

/**
 * Candidate preloading (§11.3 step 3): first ~500 KB of the medium rung via a low-priority Range
 * request, so whichever clip wins starts fast.
 */
export function preloadCandidates(entries: (ClipRef & { durationMs: number })[]) {
  for (const e of entries) {
    loadManifest(e.manifestUrl)
      .then((full) => {
        const m = e.scene ? sceneManifest(full, e.scene.id) : full;
        const base = baseOf(e.manifestUrl);
        const rungs = [...playableRungs(m)].sort((a, b) => a.height - b.height);
        const medium = rungs[Math.min(1, rungs.length - 1)]!;
        const init: RequestInit & { priority?: string } = {
          headers: { range: "bytes=0-524287" },
          priority: "low",
        };
        return fetch(base + medium.url, init);
      })
      .catch(() => {});
  }
}

export function loadDub(dubId: string): Promise<AudioBuffer> {
  let p = dubs.get(dubId);
  if (!p) {
    p = fetch(`/media/dubs/${encodeURIComponent(dubId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`dub ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => decode(audioContext(), buf));
    p.catch(() => dubs.delete(dubId));
    dubs.set(dubId, p);
  }
  return p;
}

/** Uploads a take with progress (XHR gives upload progress; fetch doesn't yet). */
export function uploadDub(
  blob: Blob,
  ticket: string,
  onProgress: (p: number) => void,
): Promise<{ dubId: string; receipt: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/dubs");
    xhr.setRequestHeader("content-type", blob.type || "application/octet-stream");
    xhr.setRequestHeader("x-upload-ticket", ticket);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () =>
      xhr.status === 200
        ? resolve(JSON.parse(xhr.responseText))
        : reject(new Error(`upload ${xhr.status}`));
    xhr.onerror = () => reject(new Error("network"));
    xhr.timeout = 30_000;
    xhr.ontimeout = () => reject(new Error("timeout"));
    xhr.send(blob);
  });
}

export async function fetchCatalog(): Promise<CatalogEntry[]> {
  const r = await fetch("/api/catalog");
  if (!r.ok) throw new Error(`catalog ${r.status}`);
  return ((await r.json()) as { clips: CatalogEntry[] }).clips;
}

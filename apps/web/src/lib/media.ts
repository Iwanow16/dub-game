import type { CatalogEntry } from "@dubroom/shared";
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
}

export interface LoadedClip {
  manifest: Manifest;
  base: string;
  videoUrl: string;
  videoHeight: number;
  bed: AudioBuffer | null;
  posterUrl: string;
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
export function chooseVideo(m: Manifest): Manifest["media"]["video"][number] {
  const ladder = [...m.media.video].sort((a, b) => b.height - a.height);
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
export function loadClip(
  entry: Pick<CatalogEntry, "manifestUrl">,
  onProgress?: (p: number) => void,
): Promise<LoadedClip> {
  let p = clips.get(entry.manifestUrl);
  if (!p) {
    p = (async () => {
      const manifest = await loadManifest(entry.manifestUrl);
      const base = baseOf(entry.manifestUrl);
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
        videoUrl: URL.createObjectURL(videoBlob),
        videoHeight: video.height,
        bed: bedBuf,
        posterUrl: base + manifest.media.poster,
      };
    })();
    p.catch(() => clips.delete(entry.manifestUrl));
    clips.set(entry.manifestUrl, p);
  }
  return p;
}

/**
 * Candidate preloading (§11.3 step 3): first ~500 KB of the medium rung via a low-priority Range
 * request, so whichever clip wins starts fast.
 */
export function preloadCandidates(entries: CatalogEntry[]) {
  for (const e of entries) {
    loadManifest(e.manifestUrl)
      .then((m) => {
        const base = baseOf(e.manifestUrl);
        const medium = [...m.media.video].sort((a, b) => a.height - b.height)[
          Math.min(1, m.media.video.length - 1)
        ]!;
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

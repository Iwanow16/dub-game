import { open, stat } from "node:fs/promises";
import type { ClipManifest } from "./manifest.ts";

/** Upload chunk size — stays under Cloudflare's 100 MB request limit (§21.7). */
export const CHUNK_BYTES = 50 * 1024 * 1024;

export type SourceKind = "video" | "bed" | "dialogue";

export interface PublishOptions {
  api: string;
  key: string;
  manifest: ClipManifest;
  files: Partial<Record<SourceKind, string>>;
  log?: (msg: string) => void;
  fetchImpl?: typeof fetch;
}

async function call<T>(f: typeof fetch, url: string, key: string, init: RequestInit): Promise<T> {
  const res = await f(url, {
    ...init,
    headers: { authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url} → ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Sends a clip package to the Clip Studio API (the same endpoints the Studio UI uses):
 * create draft → resumable chunked upload of each source → submit for processing.
 */
export async function publishPackage(opts: PublishOptions): Promise<{ draftId: string }> {
  const f = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  const base = opts.api.replace(/\/$/, "");
  const { draftId } = await call<{ draftId: string }>(f, `${base}/api/studio/drafts`, opts.key, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest: opts.manifest }),
  });
  log(`draft ${draftId}`);

  for (const [kind, path] of Object.entries(opts.files) as [SourceKind, string][]) {
    if (!path) continue;
    const size = (await stat(path)).size;
    // resume: ask the server how much it already has
    const { received } = await call<{ received: number }>(
      f,
      `${base}/api/studio/drafts/${draftId}/files/${kind}`,
      opts.key,
      { method: "GET" },
    );
    const fh = await open(path, "r");
    try {
      let offset = received;
      while (offset < size) {
        const len = Math.min(CHUNK_BYTES, size - offset);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, offset);
        await call(
          f,
          `${base}/api/studio/drafts/${draftId}/files/${kind}?offset=${offset}&total=${size}`,
          opts.key,
          {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: buf,
          },
        );
        offset += len;
        log(`${kind}: ${Math.round((offset / size) * 100)}%`);
      }
    } finally {
      await fh.close();
    }
  }

  await call(f, `${base}/api/studio/drafts/${draftId}/submit`, opts.key, { method: "POST" });
  log("submitted for processing");
  return { draftId };
}

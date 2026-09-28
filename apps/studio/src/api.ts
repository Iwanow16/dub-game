import type { ClipManifest, Issue, ValidationResult } from "@dubroom/clip-format";

export type SourceKind = "video" | "bed" | "dialogue";

export interface Draft {
  id: string;
  clipId: string;
  version: number;
  status: "draft" | "queued" | "processing" | "done" | "failed";
  manifest: ClipManifest;
  files: Partial<Record<SourceKind, { name: string; size: number; received: number }>>;
  warnings: Issue[];
  errors: Issue[];
  progress: number;
  proxyStatus: "none" | "queued" | "processing" | "done" | "failed";
  sourceDurationMs: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface ClipVersion {
  clipId: string;
  version: number;
  status: "processing" | "review" | "published" | "rejected" | "failed" | "superseded";
  manifest: ClipManifest | null;
  warnings: Issue[];
  error: string | null;
  createdAt: number;
}

export interface ClipRow {
  id: string;
  slug: string;
  status: "draft" | "processing" | "review" | "published" | "archived";
  currentVersion: number | null;
  createdAt: number;
  publishedAt: number | null;
  versions: ClipVersion[];
}

export interface Report {
  id: string;
  target_type: string;
  target_id: string;
  reason: string;
  reporter_id: string;
  created_at: number;
  resolved_at: number | null;
}

const KEY_STORAGE = "dubroom-studio-key";

export function getKey(): string {
  try {
    return sessionStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function setKey(key: string) {
  try {
    if (key) sessionStorage.setItem(KEY_STORAGE, key);
    else sessionStorage.removeItem(KEY_STORAGE);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error?: string; message?: string; issues?: Issue[] },
  ) {
    super(body.message ?? body.error ?? `HTTP ${status}`);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/studio${path}`, {
    ...init,
    headers: { authorization: `Bearer ${getKey()}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T);
  if (!res.ok) throw new ApiError(res.status, body as { error?: string });
  return body;
}

const json = (body: unknown): RequestInit => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  me: () => call<{ ok: true; author: string }>("/me"),
  clips: () => call<{ clips: ClipRow[] }>("/clips"),
  drafts: () => call<{ drafts: Draft[] }>("/drafts"),
  draft: (id: string) => call<{ draft: Draft; check: ValidationResult }>(`/drafts/${id}`),
  createDraft: (manifest: ClipManifest) =>
    call<{ draftId: string; draft: Draft }>("/drafts", { method: "POST", ...json({ manifest }) }),
  saveManifest: (id: string, manifest: ClipManifest) =>
    call<{ draft: Draft; check: ValidationResult }>(`/drafts/${id}/manifest`, {
      method: "PUT",
      ...json({ manifest }),
    }),
  deleteDraft: (id: string) => call(`/drafts/${id}`, { method: "DELETE" }),
  submit: (id: string) => call<{ draft: Draft }>(`/drafts/${id}/submit`, { method: "POST" }),
  publish: (clipId: string, v: number) =>
    call(`/clips/${clipId}/versions/${v}/publish`, { method: "POST" }),
  reject: (clipId: string, v: number, reason: string) =>
    call(`/clips/${clipId}/versions/${v}/reject`, { method: "POST", ...json({ reason }) }),
  archive: (clipId: string) => call(`/clips/${clipId}/archive`, { method: "POST" }),
  unarchive: (clipId: string) => call(`/clips/${clipId}/unarchive`, { method: "POST" }),
  reports: () => call<{ reports: Report[] }>("/reports"),
  resolveReport: (id: string) => call(`/reports/${id}/resolve`, { method: "POST" }),

  /** Fetches an uploaded source (needs the auth header, so no plain <video src>). */
  async sourceBlob(id: string, kind: SourceKind | "proxy"): Promise<Blob> {
    const res = await fetch(`/api/studio/drafts/${id}/source/${kind}`, {
      headers: { authorization: `Bearer ${getKey()}` },
    });
    if (!res.ok) throw new ApiError(res.status, {});
    return res.blob();
  },
};

/** 50 MB chunks keep every request under Cloudflare's 100 MB limit (§21.7). */
export const CHUNK = 50 * 1024 * 1024;

/**
 * Resumable upload: asks the server how much it has and continues from there, so a dropped
 * connection or a closed tab doesn't restart a 2 GB upload.
 */
export async function uploadSource(
  draftId: string,
  kind: SourceKind,
  file: File,
  onProgress: (p: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { received } = await call<{ received: number; size: number | null }>(
    `/drafts/${draftId}/files/${kind}`,
  );
  let offset = received > 0 && received <= file.size ? received : 0;
  onProgress(offset / file.size);
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(file.size, offset + CHUNK));
    const q = new URLSearchParams({
      offset: String(offset),
      total: String(file.size),
      name: file.name,
    });
    let attempt = 0;
    for (;;) {
      try {
        const r = await call<{ received: number }>(`/drafts/${draftId}/files/${kind}?${q}`, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: chunk,
          signal,
        });
        offset = r.received;
        break;
      } catch (e) {
        if (signal?.aborted) throw e;
        if (
          e instanceof ApiError &&
          e.status === 409 &&
          typeof (e.body as { received?: number }).received === "number"
        ) {
          offset = (e.body as { received: number }).received;
          break;
        }
        if (++attempt > 4) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    onProgress(offset / file.size);
  }
}

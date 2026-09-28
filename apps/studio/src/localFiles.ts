import type { SourceKind } from "./api.ts";

/** Files picked in this tab, reused by the editor instead of downloading them back. */
export const localFiles = new Map<string, Partial<Record<SourceKind, File>>>();

export function setLocalFile(draftId: string, kind: SourceKind, file: File) {
  localFiles.set(draftId, { ...localFiles.get(draftId), [kind]: file });
}

export function probeDuration(file: Blob): Promise<{ durationMs: number; height: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      resolve({ durationMs: Math.round(v.duration * 1000), height: v.videoHeight });
      URL.revokeObjectURL(url);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("браузер не смог прочитать видео"));
    };
    v.src = url;
  });
}

/** Can this browser decode the file? (HEVC .mov, some MKV and — in some builds — H.264 can't.) */
export function canPlay(url: string, timeoutMs = 6000): Promise<boolean> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const done = (ok: boolean) => {
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    v.preload = "auto";
    v.muted = true;
    v.onloadeddata = () => done(v.videoWidth > 0);
    v.onerror = () => done(false);
    v.src = url;
  });
}

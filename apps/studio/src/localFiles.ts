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

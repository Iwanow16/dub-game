import { create } from "zustand";
import { classifyMicError, openMicrophone, type MicError } from "@dubroom/audio";
import { usePrefs } from "./prefs.ts";

/** Shared microphone stream, opened once per session after an explicit explanation (US-3). */
export const useMic = create<{
  stream: MediaStream | null;
  error: MicError | null;
  open: () => Promise<MediaStream | null>;
  close: () => void;
}>((set, get) => ({
  stream: null,
  error: null,
  async open() {
    const current = get().stream;
    if (current && current.getAudioTracks().some((t) => t.readyState === "live")) return current;
    try {
      const stream = await openMicrophone({ headphones: usePrefs.getState().headphones });
      set({ stream, error: null });
      return stream;
    } catch (e) {
      set({ error: classifyMicError(e), stream: null });
      return null;
    }
  },
  close() {
    get()
      .stream?.getTracks()
      .forEach((t) => t.stop());
    set({ stream: null });
  },
}));

export function browserFamily(): "chrome" | "firefox" | "safari" {
  const ua = navigator.userAgent;
  if (/firefox/i.test(ua)) return "firefox";
  if (/safari/i.test(ua) && !/chrome|chromium|crios|edg/i.test(ua)) return "safari";
  return "chrome";
}

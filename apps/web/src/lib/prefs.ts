import { create } from "zustand";
import { load, save } from "./storage.ts";

export type Quality = "auto" | 720 | 480 | 360;

interface Prefs {
  headphones: boolean;
  /** measured round-trip latency (ms) or null if never calibrated (§12.2) */
  latencyMs: number | null;
  soundChecked: boolean;
  subtitleScale: 1 | 1.25 | 1.5;
  quality: Quality;
  uiSounds: boolean;
  lightTheme: boolean;
  tipsSeen: boolean;
}

const defaults: Prefs = {
  headphones: true,
  latencyMs: null,
  soundChecked: false,
  subtitleScale: 1,
  quality: "auto",
  uiSounds: true,
  lightTheme: false,
  tipsSeen: false,
};

export const usePrefs = create<Prefs & { set: (p: Partial<Prefs>) => void }>((set, get) => ({
  ...defaults,
  ...load<Partial<Prefs>>("prefs", {}),
  set(p) {
    set(p);
    const { set: _s, ...rest } = get();
    save("prefs", rest);
  },
}));

export function applyVisualPrefs(p: Pick<Prefs, "subtitleScale" | "lightTheme">) {
  const root = document.documentElement;
  root.style.setProperty("--subtitle-scale", String(p.subtitleScale));
  if (p.lightTheme) root.dataset.theme = "light";
  else delete root.dataset.theme;
}

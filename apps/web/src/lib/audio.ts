import { setPitchWorkletUrl } from "@dubroom/audio";
import workletUrl from "@dubroom/audio/pitch-worklet.js?url";
import { usePrefs } from "./prefs.ts";

setPitchWorkletUrl(workletUrl);

let ctx: AudioContext | null = null;

/** One AudioContext for the whole app — bed, voices and UI sounds share one clock (§12.1). */
export function audioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48_000 });
  return ctx;
}

/** Safari needs a user gesture before audio may start (§12.4) — call from click handlers. */
export async function unlockAudio() {
  const c = audioContext();
  if (c.state !== "running") await c.resume().catch(() => {});
}

/** Converts an AudioContext time to performance.now() milliseconds. */
export function ctxTimeToPerf(c: AudioContext, t: number): number {
  const ts = c.getOutputTimestamp?.();
  if (
    ts &&
    ts.contextTime !== undefined &&
    ts.performanceTime !== undefined &&
    ts.performanceTime > 0
  ) {
    return ts.performanceTime + (t - ts.contextTime) * 1000;
  }
  return performance.now() + (t - c.currentTime) * 1000;
}

/** Output latency estimate when the player hasn't calibrated yet. */
export function defaultRoundTripMs(): number {
  const c = audioContext();
  const out = ((c.outputLatency || 0) + (c.baseLatency || 0)) * 1000;
  return Math.round(out + 20); // + typical input latency
}

export function roundTripMs(): number {
  return usePrefs.getState().latencyMs ?? defaultRoundTripMs();
}

/* ---------- interface sounds (§20.6), synthesized, switchable ---------- */

function beep(freq: number, durMs: number, when = 0, type: OscillatorType = "sine", gain = 0.12) {
  if (!usePrefs.getState().uiSounds) return;
  const c = audioContext();
  if (c.state !== "running") return;
  const t0 = c.currentTime + when;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + durMs / 1000 + 0.02);
}

export const sounds = {
  tick: () => beep(880, 60, 0, "square", 0.05),
  recStart: () => beep(1320, 90, 0, "triangle", 0.15),
  countdown: () => beep(660, 120, 0, "sine", 0.12),
  fanfare: () => {
    [523, 659, 784, 1047].forEach((f, i) => beep(f, 260, i * 0.12, "triangle", 0.12));
  },
  vote: () => beep(990, 70, 0, "sine", 0.08),
};

/** Click track used by calibration: returns AudioContext times of the clicks. */
export function playClicks(count: number, intervalS: number, startIn = 0.6): number[] {
  const c = audioContext();
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = c.currentTime + startIn + i * intervalS;
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.value = 1500;
    g.gain.setValueAtTime(0.4, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + 0.05);
    times.push(t);
  }
  return times;
}

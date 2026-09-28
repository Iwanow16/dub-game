import { describe, expect, it } from "vitest";
import { activeRms, alignOffsetMs, detectOnsets, estimateLatency, rms } from "./analysis.ts";
import { pickRecordingMime } from "./recorder.ts";

const SR = 48_000;

function clapTrack(clapsMs: number[], lengthMs: number): Float32Array {
  const s = new Float32Array(Math.floor((lengthMs / 1000) * SR));
  let seed = 1;
  for (let i = 0; i < s.length; i++) {
    seed = (seed * 16807) % 2147483647;
    s[i] = ((seed / 2147483647) * 2 - 1) * 0.002; // room noise
  }
  for (const t of clapsMs) {
    const start = Math.floor((t / 1000) * SR);
    for (let i = 0; i < SR * 0.03 && start + i < s.length; i++) {
      s[start + i] = Math.sin(i * 0.7) * 0.8 * Math.exp(-i / (SR * 0.006));
    }
  }
  return s;
}

describe("audio analysis", () => {
  it("computes RMS and gates silence", () => {
    const s = new Float32Array(SR).fill(0.5);
    expect(rms(s)).toBeCloseTo(0.5);
    const half = new Float32Array(SR);
    half.fill(0.2, 0, SR / 2);
    expect(activeRms(half, SR)).toBeCloseTo(0.2, 2);
  });

  it("detects claps within a few ms", () => {
    const claps = [500, 1100, 1700, 2300];
    const found = detectOnsets(clapTrack(claps, 3000), SR);
    expect(found).toHaveLength(4);
    found.forEach((t, i) => expect(Math.abs(t - claps[i]!)).toBeLessThan(5));
  });

  it("estimates round-trip latency from clicks and claps (§12.2)", () => {
    const clicks = [500, 1100, 1700, 2300];
    const onsets = detectOnsets(
      clapTrack(
        clicks.map((c) => c + 120),
        3000,
      ),
      SR,
    );
    const r = estimateLatency(clicks, onsets)!;
    expect(Math.abs(r.latencyMs - 120)).toBeLessThanOrEqual(5);
    expect(r.matched).toBe(4);
    expect(estimateLatency(clicks, [])).toBeNull();
  });

  it("aligns the voice with the documented formula", () => {
    // recorder started 3 s before the clip (countdown), 120 ms round trip, +20 ms manual nudge
    expect(
      alignOffsetMs({
        recStartMs: 1000,
        clipStartMs: 4000,
        roundTripLatencyMs: 120,
        manualOffsetMs: 20,
      }),
    ).toBe(-3100);
  });

  it("prefers Opus/WebM and falls back to AAC for Safari", () => {
    expect(pickRecordingMime(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickRecordingMime((t) => t.startsWith("audio/mp4"))).toBe("audio/mp4;codecs=mp4a.40.2");
    expect(pickRecordingMime(() => false)).toBeNull();
  });
});

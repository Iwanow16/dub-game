/** Pure DSP helpers — no Web Audio, unit-testable in Node. */

export function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  const n = Math.max(1, to - from);
  for (let i = from; i < to; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / n);
}

/** RMS of the loud parts only (ignores silence between phrases) — used for loudness matching. */
export function activeRms(samples: Float32Array, sampleRate: number, gate = 0.01): number {
  const win = Math.max(1, Math.floor(sampleRate * 0.05));
  let sum = 0;
  let count = 0;
  for (let i = 0; i + win <= samples.length; i += win) {
    const r = rms(samples, i, i + win);
    if (r > gate) {
      sum += r * r;
      count++;
    }
  }
  return count ? Math.sqrt(sum / count) : 0;
}

/**
 * Finds sharp onsets (claps) in a mono signal: points where the short-term energy jumps well above
 * the recent background. Returns times in ms; onsets closer than `minGapMs` are merged.
 */
export function detectOnsets(
  samples: Float32Array,
  sampleRate: number,
  opts: { threshold?: number; minGapMs?: number } = {},
): number[] {
  const threshold = opts.threshold ?? 0.08;
  const minGap = ((opts.minGapMs ?? 250) / 1000) * sampleRate;
  const hop = Math.max(1, Math.floor(sampleRate * 0.002));
  const onsets: number[] = [];
  let background = 0;
  let last = -Infinity;
  for (let i = 0; i + hop <= samples.length; i += hop) {
    const e = rms(samples, i, i + hop);
    if (e > threshold && e > background * 4 && i - last > minGap) {
      // refine to the first sample above half the peak level inside this hop
      let j = i;
      while (j < i + hop && Math.abs(samples[j]!) < e * 0.5) j++;
      onsets.push((j / sampleRate) * 1000);
      last = i;
    }
    background = background * 0.95 + e * 0.05;
  }
  return onsets;
}

/**
 * Round-trip latency calibration (§12.2): the player claps along with clicks played at
 * `clickTimesMs` (relative to recording start). Each click is matched with the nearest clap that
 * follows it within `windowMs`; the median difference is the total input+output latency.
 */
export function estimateLatency(
  clickTimesMs: number[],
  onsetsMs: number[],
  windowMs = 400,
): { latencyMs: number; matched: number; spreadMs: number } | null {
  const diffs: number[] = [];
  for (const click of clickTimesMs) {
    const clap = onsetsMs.find((o) => o >= click - 30 && o <= click + windowMs);
    if (clap !== undefined) diffs.push(clap - click);
  }
  if (diffs.length < Math.ceil(clickTimesMs.length / 2)) return null;
  const sorted = [...diffs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return {
    latencyMs: Math.max(0, Math.round(median)),
    matched: diffs.length,
    spreadMs: Math.round(sorted[sorted.length - 1]! - sorted[0]!),
  };
}

/**
 * Where to place the dry voice relative to the clip (§12.2):
 *   offset = (recStart − clipStart) − roundTripLatency + manualOffset
 * where roundTripLatency = output latency (what the player heard was late) + input latency
 * (what we captured is late). A negative offset means the recording starts before the clip.
 */
export function alignOffsetMs(p: {
  recStartMs: number;
  clipStartMs: number;
  roundTripLatencyMs: number;
  manualOffsetMs: number;
}): number {
  return Math.round(p.recStartMs - p.clipStartMs - p.roundTripLatencyMs + p.manualOffsetMs);
}

/** Envelope for mouth animation / level meters: values 0..1 per `frameMs`. */
export function envelope(samples: Float32Array, sampleRate: number, frameMs = 50): number[] {
  const win = Math.max(1, Math.floor((sampleRate * frameMs) / 1000));
  const out: number[] = [];
  for (let i = 0; i < samples.length; i += win) {
    out.push(Math.min(1, rms(samples, i, Math.min(samples.length, i + win)) * 6));
  }
  return out;
}

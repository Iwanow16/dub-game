let ctx: AudioContext | null = null;

export function audioCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext({ sampleRate: 48_000 });
  return ctx;
}

/** Min/max peaks per bucket for waveform drawing. */
export function peaks(buffer: AudioBuffer, buckets: number): Float32Array {
  const data = buffer.getChannelData(0);
  const out = new Float32Array(buckets * 2);
  const size = Math.max(1, Math.floor(data.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let min = 0;
    let max = 0;
    for (let i = b * size; i < Math.min(data.length, (b + 1) * size); i++) {
      const v = data[i]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out[b * 2] = min;
    out[b * 2 + 1] = max;
  }
  return out;
}

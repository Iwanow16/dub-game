let ctx: AudioContext | null = null;

export function audioCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext({ sampleRate: 48_000 });
  return ctx;
}

/** Waveform as (min, max) signed 8-bit pairs, `perSec` pairs per second (worker's peaks.bin format). */
export interface Peaks {
  data: Int8Array;
  perSec: number;
}

export function peaksFromBuffer(buffer: AudioBuffer, perSec = 100): Peaks {
  const src = buffer.getChannelData(0);
  const win = Math.max(1, Math.round(buffer.sampleRate / perSec));
  const n = Math.ceil(src.length / win);
  const data = new Int8Array(n * 2);
  for (let w = 0; w < n; w++) {
    let min = 0;
    let max = 0;
    for (let i = w * win; i < Math.min(src.length, (w + 1) * win); i++) {
      const v = src[i]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    data[w * 2] = Math.round(min * 127);
    data[w * 2 + 1] = Math.round(max * 127);
  }
  return { data, perSec };
}

export async function fetchPeaks(url: string): Promise<Peaks | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  return buf.byteLength ? { data: new Int8Array(buf), perSec: 100 } : null;
}

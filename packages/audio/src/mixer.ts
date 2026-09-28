import type { EffectId } from "@dubroom/shared";
import { createEffect, type EffectChain } from "./effects.ts";

export interface VoiceLayer {
  buffer: AudioBuffer;
  effect: EffectId;
  gain: number;
  /** where the recording's t=0 sits on the clip timeline, ms (may be negative) */
  offsetMs: number;
}

export interface ScheduledMix {
  stop(): void;
  /** analysers per voice for mouth animation */
  analysers: AnalyserNode[];
}

/**
 * Plays bed + voices sample-accurately from `when` (AudioContext time) — the common path for
 * review, watch and Studio preview (§13). Video is slaved to the same clock by the caller.
 */
export async function scheduleMix(
  ctx: AudioContext,
  opts: {
    bed: AudioBuffer | null;
    voices: VoiceLayer[];
    when: number;
    /** start this far into the clip, seconds */
    clipOffset?: number;
    bedGain?: number;
    destination?: AudioNode;
  },
): Promise<ScheduledMix> {
  const dest = opts.destination ?? ctx.destination;
  const at = opts.clipOffset ?? 0;
  const nodes: AudioScheduledSourceNode[] = [];
  const chains: EffectChain[] = [];
  const analysers: AnalyserNode[] = [];

  if (opts.bed) {
    const src = ctx.createBufferSource();
    src.buffer = opts.bed;
    const g = ctx.createGain();
    g.gain.value = opts.bedGain ?? 1;
    src.connect(g).connect(dest);
    src.start(opts.when, Math.min(at, opts.bed.duration));
    nodes.push(src);
  }

  for (const v of opts.voices) {
    const chain = await createEffect(ctx, v.effect);
    const src = ctx.createBufferSource();
    src.buffer = v.buffer;
    const g = ctx.createGain();
    g.gain.value = v.gain;
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(g).connect(chain.input);
    chain.output.connect(dest);
    g.connect(an);
    // voice t=0 is at clip time offset; we start the clip at `at`
    const voiceStartClip = v.offsetMs / 1000;
    const rel = voiceStartClip - at; // >0: start later; <0: skip into the buffer
    if (rel >= 0) src.start(opts.when + rel);
    else if (-rel < v.buffer.duration) src.start(opts.when, -rel);
    nodes.push(src);
    chains.push(chain);
    analysers.push(an);
  }

  return {
    analysers,
    stop() {
      for (const n of nodes) {
        try {
          n.stop();
        } catch {
          /* not started */
        }
        n.disconnect();
      }
      for (const c of chains) c.dispose();
    },
  };
}

export function analyserLevel(an: AnalyserNode, scratch = new Float32Array(an.fftSize)): number {
  an.getFloatTimeDomainData(scratch);
  let sum = 0;
  for (const v of scratch) sum += v * v;
  return Math.min(1, Math.sqrt(sum / scratch.length) * 6);
}

/** decodeAudioData with a promise and a Blob/ArrayBuffer input. */
export async function decode(
  ctx: BaseAudioContext,
  data: Blob | ArrayBuffer,
): Promise<AudioBuffer> {
  const buf = data instanceof Blob ? await data.arrayBuffer() : data;
  return ctx.decodeAudioData(buf.slice(0));
}

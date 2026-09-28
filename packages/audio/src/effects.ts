import type { EffectId } from "@dubroom/shared";

/**
 * Voice effects (§12.3). Applied at playback on the dry recording, so the effect can be changed
 * after recording and every client renders the same thing.
 */
export interface EffectChain {
  input: AudioNode;
  output: AudioNode;
  dispose(): void;
}

export const EFFECT_LABELS: Record<EffectId, { ru: string; en: string; icon: string }> = {
  none: { ru: "Без", en: "None", icon: "🎙" },
  robot: { ru: "Робот", en: "Robot", icon: "🤖" },
  bass: { ru: "Бас", en: "Bass", icon: "🐻" },
  echo: { ru: "Эхо", en: "Echo", icon: "🏔" },
  radio: { ru: "Рация", en: "Radio", icon: "📻" },
  chipmunk: { ru: "Бурундук", en: "Chipmunk", icon: "🐿" },
};

let workletUrl: string | null = null;
const loaded = new WeakMap<BaseAudioContext, Promise<boolean>>();

/** Set once by the app: URL of pitch-worklet.js served from our own origin (CSP: script-src 'self'). */
export function setPitchWorkletUrl(url: string) {
  workletUrl = url;
}

export function ensureWorklets(ctx: BaseAudioContext): Promise<boolean> {
  let p = loaded.get(ctx);
  if (!p) {
    p =
      workletUrl && ctx.audioWorklet
        ? ctx.audioWorklet.addModule(workletUrl).then(
            () => true,
            () => false,
          )
        : Promise.resolve(false);
    loaded.set(ctx, p);
  }
  return p;
}

function pitch(ctx: BaseAudioContext, ratio: number, hasWorklet: boolean): AudioNode {
  if (!hasWorklet) {
    // fallback without worklets: keep the voice audible, colour it with EQ
    const f = ctx.createBiquadFilter();
    f.type = ratio < 1 ? "lowshelf" : "highshelf";
    f.frequency.value = ratio < 1 ? 250 : 2500;
    f.gain.value = 9;
    return f;
  }
  const node = new AudioWorkletNode(ctx, "dubroom-pitch-shifter", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  node.parameters.get("ratio")!.value = ratio;
  return node;
}

function distortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

function impulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  // deterministic noise so all clients hear the same room
  let seed = 12345;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      d[i] = ((seed / 0x7fffffff) * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

/** Builds the node chain for an effect. Call `ensureWorklets(ctx)` first for pitch effects. */
export async function createEffect(ctx: BaseAudioContext, effect: EffectId): Promise<EffectChain> {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const extra: AudioNode[] = [];
  const sources: AudioScheduledSourceNode[] = [];

  switch (effect) {
    case "robot": {
      // ring modulator + a little metallic comb
      const ring = ctx.createGain();
      ring.gain.value = 0;
      const osc = ctx.createOscillator();
      osc.frequency.value = 55;
      osc.connect(ring.gain);
      osc.start();
      sources.push(osc);
      const comb = ctx.createDelay(0.05);
      comb.delayTime.value = 0.012;
      const fb = ctx.createGain();
      fb.gain.value = 0.5;
      input.connect(ring).connect(comb).connect(output);
      comb.connect(fb).connect(comb);
      ring.connect(output);
      output.gain.value = 1.6;
      extra.push(ring, comb, fb);
      break;
    }
    case "bass":
    case "chipmunk": {
      const ok = await ensureWorklets(ctx);
      const p = pitch(ctx, effect === "bass" ? 0.72 : 1.55, ok);
      input.connect(p).connect(output);
      extra.push(p);
      break;
    }
    case "echo": {
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.28;
      const fb = ctx.createGain();
      fb.gain.value = 0.38;
      const wet = ctx.createGain();
      wet.gain.value = 0.45;
      const conv = ctx.createConvolver();
      conv.buffer = impulse(ctx, 1.6, 3);
      const convWet = ctx.createGain();
      convWet.gain.value = 0.35;
      input.connect(output);
      input.connect(delay).connect(wet).connect(output);
      delay.connect(fb).connect(delay);
      input.connect(conv).connect(convWet).connect(output);
      extra.push(delay, fb, wet, conv, convWet);
      break;
    }
    case "radio": {
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 500;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 3200;
      const shaper = ctx.createWaveShaper();
      shaper.curve = distortionCurve(40);
      shaper.oversample = "2x";
      input.connect(hp).connect(lp).connect(shaper).connect(output);
      output.gain.value = 0.8;
      extra.push(hp, lp, shaper);
      break;
    }
    case "none":
    default:
      input.connect(output);
  }

  return {
    input,
    output,
    dispose() {
      for (const s of sources) s.stop();
      for (const n of [input, output, ...extra]) n.disconnect();
    },
  };
}

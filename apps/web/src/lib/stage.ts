import {
  createEffect,
  scheduleMix,
  type EffectChain,
  type ScheduledMix,
  type VoiceLayer,
} from "@dubroom/audio";
import type { EffectId } from "@dubroom/shared";
import { audioContext } from "./audio.ts";
import type { LoadedClip } from "./media.ts";

export interface PlayOptions {
  clip: LoadedClip;
  /** AudioContext time at which clip time 0 (or `fromMs`) plays; default: now + 0.15 s */
  when?: number;
  fromMs?: number;
  /** decoded voices (short clips and scenes) */
  voices?: VoiceLayer[];
  /** streamed voices (long clips played whole) */
  streamVoices?: StreamVoice[];
  bedGain?: number;
  /** extra ms to keep running after the clip ends (to capture trailing speech) */
  tailMs?: number;
  onPosition?: (ms: number) => void;
}

/** A take played from its URL instead of a decoded buffer (ADR-0009). */
export interface StreamVoice {
  src: string;
  effect: EffectId;
  gain: number;
  /** where the recording's t=0 sits on the clip timeline, ms (may be negative) */
  offsetMs: number;
}

export interface Playback {
  when: number;
  mix: ScheduledMix;
  done: Promise<void>;
  stop(): void;
}

/**
 * Plays a clip with bed + voices on the AudioContext clock and keeps the (silent) <video> slaved to
 * it (§13). The audio clock is authoritative; video is corrected when it drifts > 60 ms.
 */
export async function playOnStage(video: HTMLVideoElement, o: PlayOptions): Promise<Playback> {
  if (o.clip.streaming) return playStreaming(video, o);
  const ctx = audioContext();
  const from = (o.fromMs ?? 0) / 1000;
  const when = o.when ?? ctx.currentTime + 0.15;
  const mix = await scheduleMix(ctx, {
    bed: o.clip.bed,
    voices: o.voices ?? [],
    when,
    clipOffset: from,
    bedGain: o.bedGain,
  });
  const durS = o.clip.manifest.durationMs / 1000;
  const avOffset = (o.clip.manifest.sync?.videoAudioOffsetMs ?? 0) / 1000;
  if (video.src !== o.clip.videoUrl) video.src = o.clip.videoUrl;
  video.muted = true;
  video.pause();
  video.currentTime = Math.max(0, from + avOffset);

  let stopped = false;
  let raf = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  let started = false;

  const tick = () => {
    if (stopped) return;
    const pos = ctx.currentTime - when + from; // clip seconds
    if (pos >= 0 && !started) {
      started = true;
      video.currentTime = Math.max(0, pos + avOffset);
      void video.play().catch(() => {});
    }
    if (started && pos < durS) {
      const drift = video.currentTime - (pos + avOffset);
      if (Math.abs(drift) > 0.06 && !video.seeking) video.currentTime = pos + avOffset;
    }
    if (pos >= durS) video.pause();
    o.onPosition?.(Math.max(0, Math.min(pos, durS)) * 1000);
    if (pos >= durS + (o.tailMs ?? 0) / 1000) {
      finish();
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  const finish = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    video.pause();
    mix.stop();
    resolveDone();
  };
  raf = requestAnimationFrame(tick);

  return { when, mix, done, stop: finish };
}

function canPlay(el: HTMLMediaElement, timeoutMs = 15_000): Promise<void> {
  if (el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      el.removeEventListener("canplay", done);
      el.removeEventListener("error", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    el.addEventListener("canplay", done);
    el.addEventListener("error", done);
  });
}

/**
 * Streaming playback for long clips played whole (ADR-0009): video, bed and voices are media
 * elements (range requests, nothing long is decoded into memory) routed through Web Audio for
 * effects and level meters. The AudioContext clock stays the master: elements that drift are nudged
 * with playbackRate (±5 %) and re-seeked only when far off. Voices recorded with MediaRecorder
 * aren't seekable, so each starts from its beginning at its own moment instead of being seeked.
 */
async function playStreaming(video: HTMLVideoElement, o: PlayOptions): Promise<Playback> {
  const ctx = audioContext();
  const from = (o.fromMs ?? 0) / 1000;
  const durS = o.clip.manifest.durationMs / 1000;
  const avOffset = (o.clip.manifest.sync?.videoAudioOffsetMs ?? 0) / 1000;
  const chains: EffectChain[] = [];
  const graph: AudioNode[] = [];
  const analysers: AnalyserNode[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];

  if (video.src !== o.clip.videoUrl) video.src = o.clip.videoUrl;
  video.muted = true;
  video.preload = "auto";
  video.pause();
  video.currentTime = Math.max(0, from + avOffset);

  const bed = new Audio();
  bed.preload = "auto";
  bed.src = o.clip.bedUrl ?? "";
  bed.currentTime = from;
  const bedNode = ctx.createMediaElementSource(bed);
  const bedGain = ctx.createGain();
  bedGain.gain.value = o.bedGain ?? 1;
  bedNode.connect(bedGain).connect(ctx.destination);
  graph.push(bedNode, bedGain);

  const voices: { el: HTMLAudioElement; startClip: number; started: boolean }[] = [];
  for (const v of o.streamVoices ?? []) {
    const el = new Audio();
    el.preload = "auto";
    el.src = v.src;
    const src = ctx.createMediaElementSource(el);
    const g = ctx.createGain();
    g.gain.value = v.gain;
    const chain = await createEffect(ctx, v.effect);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(g).connect(chain.input);
    chain.output.connect(ctx.destination);
    g.connect(an);
    graph.push(src, g, an);
    chains.push(chain);
    analysers.push(an);
    const startClip = v.offsetMs / 1000;
    if (startClip < from) el.currentTime = from - startClip; // late start: best effort
    voices.push({ el, startClip, started: false });
  }

  await Promise.all([canPlay(video), canPlay(bed), ...voices.map((v) => canPlay(v.el))]);
  const when = Math.max(o.when ?? 0, ctx.currentTime + 0.3);

  const at = (ctxTime: number, fn: () => void) => {
    timers.push(setTimeout(fn, Math.max(0, (ctxTime - ctx.currentTime) * 1000)));
  };
  at(when, () => {
    void video.play().catch(() => {});
    void bed.play().catch(() => {});
  });
  for (const v of voices) {
    at(when + Math.max(0, v.startClip - from), () => {
      v.started = true;
      void v.el.play().catch(() => {});
    });
  }

  const steer = (el: HTMLMediaElement, target: number, maxJump: number) => {
    if (el.paused || el.seeking) return;
    const diff = el.currentTime - target;
    if (Math.abs(diff) > maxJump) {
      el.currentTime = Math.max(0, target);
      el.playbackRate = 1;
    } else if (Math.abs(diff) > 0.04) {
      el.playbackRate = 1 - Math.max(-0.05, Math.min(0.05, diff * 0.5));
    } else {
      el.playbackRate = 1;
    }
  };

  let stopped = false;
  let raf = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const tick = () => {
    if (stopped) return;
    const c = ctx.currentTime - when + from;
    if (c >= 0) {
      steer(video, c + avOffset, 0.3);
      steer(bed, c, 0.3);
      for (const v of voices) if (v.started) steer(v.el, c - v.startClip, 2);
    }
    if (c >= durS) {
      video.pause();
      bed.pause();
    }
    o.onPosition?.(Math.max(0, Math.min(c, durS)) * 1000);
    if (c >= durS + (o.tailMs ?? 0) / 1000) {
      finish();
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  const finish = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    timers.forEach(clearTimeout);
    video.pause();
    for (const el of [bed, ...voices.map((v) => v.el)]) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    for (const n of graph) n.disconnect();
    for (const c of chains) c.dispose();
    resolveDone();
  };
  raf = requestAnimationFrame(tick);

  return { when, mix: { analysers, stop: finish }, done, stop: finish };
}

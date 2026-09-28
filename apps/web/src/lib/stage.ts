import { scheduleMix, type ScheduledMix, type VoiceLayer } from "@dubroom/audio";
import { audioContext } from "./audio.ts";
import type { LoadedClip } from "./media.ts";

export interface PlayOptions {
  clip: LoadedClip;
  /** AudioContext time at which clip time 0 (or `fromMs`) plays; default: now + 0.15 s */
  when?: number;
  fromMs?: number;
  voices?: VoiceLayer[];
  bedGain?: number;
  /** extra ms to keep running after the clip ends (to capture trailing speech) */
  tailMs?: number;
  onPosition?: (ms: number) => void;
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

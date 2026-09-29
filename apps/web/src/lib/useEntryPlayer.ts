import { useCallback, useEffect, useRef, useState } from "react";
import { analyserLevel, type VoiceLayer } from "@dubroom/audio";
import { STREAM_THRESHOLD_MS, type Entry } from "@dubroom/shared";
import { audioContext, unlockAudio } from "./audio.ts";
import { loadClip, loadDub, type ClipRef, type LoadedClip } from "./media.ts";
import { playOnStage, type Playback, type StreamVoice } from "./stage.ts";

/**
 * Plays entries (a clip + one or more dubs) on a stage. Loads the clip and prefetches all dubs as
 * soon as entries are known (§11.6: ~0.75 MB for 5 players, fits in the watch lead time). Long
 * clips played whole stream their takes instead (ADR-0009).
 */
export function useEntryPlayer(
  clipEntry: (ClipRef & { durationMs: number }) | null,
  entries: Entry[],
) {
  const streamed = Boolean(
    clipEntry && !clipEntry.scene && clipEntry.durationMs > STREAM_THRESHOLD_MS,
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const playback = useRef<Playback | null>(null);
  const [clip, setClip] = useState<LoadedClip | null>(null);
  const [pos, setPos] = useState(-1);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [playing, setPlaying] = useState<string | null>(null);

  const manifestUrl = clipEntry?.manifestUrl;
  const sceneId = clipEntry?.scene?.id;
  useEffect(() => {
    if (!manifestUrl) return;
    let alive = true;
    loadClip({ manifestUrl, scene: sceneId ? { id: sceneId } : null })
      .then((c) => alive && setClip(c))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [manifestUrl, sceneId]);

  const dubKey = entries.flatMap((e) => e.tracks.map((t) => t.dubId)).join(",");
  useEffect(() => {
    if (streamed) return;
    for (const id of dubKey.split(",").filter(Boolean)) loadDub(id).catch(() => {});
  }, [dubKey, streamed]);

  useEffect(() => () => playback.current?.stop(), []);

  const stop = useCallback(() => {
    playback.current?.stop();
    playback.current = null;
    setPlaying(null);
    setPos(-1);
    setLevels({});
  }, []);

  /** `startAtClientMs`: wall-clock (client) time when the clip should start; may be in the past. */
  const play = useCallback(
    async (entry: Entry, startAtClientMs?: number) => {
      if (!clip || !videoRef.current) return;
      await unlockAudio();
      playback.current?.stop();
      const voices: (VoiceLayer & { key: string })[] = [];
      const streamVoices: (StreamVoice & { key: string })[] = [];
      if (clip.streaming) {
        entry.tracks.forEach((t, i) =>
          streamVoices.push({
            src: `/media/dubs/${encodeURIComponent(t.dubId)}`,
            effect: t.effect,
            gain: t.gain,
            offsetMs: t.offsetMs,
            key: t.playerId || `t${i}`,
          }),
        );
      } else {
        await Promise.all(
          entry.tracks.map(async (t, i) => {
            try {
              const buffer = await loadDub(t.dubId);
              voices.push({
                buffer,
                effect: t.effect,
                gain: t.gain,
                offsetMs: t.offsetMs,
                key: t.playerId || `t${i}`,
              });
            } catch {
              /* a missing file just leaves that voice out */
            }
          }),
        );
      }
      const keys = (clip.streaming ? streamVoices : voices).map((v) => v.key);
      const ctx = audioContext();
      let when: number | undefined;
      let fromMs = 0;
      if (startAtClientMs !== undefined) {
        const delay = (startAtClientMs - Date.now()) / 1000;
        if (delay >= 0.05) when = ctx.currentTime + delay;
        else fromMs = Math.min(clip.manifest.durationMs, -delay * 1000); // late: catch up
      }
      if (fromMs >= clip.manifest.durationMs - 200) return;
      const pb = await playOnStage(videoRef.current, {
        clip,
        voices,
        streamVoices,
        when,
        fromMs,
        onPosition: (ms) => {
          setPos(ms);
          const lv: Record<string, number> = {};
          pb?.mix.analysers.forEach((an, i) => (lv[keys[i]!] = analyserLevel(an)));
          setLevels(lv);
        },
      });
      playback.current = pb;
      setPlaying(entry.id);
      await pb.done;
      if (playback.current === pb) {
        setPlaying(null);
        setPos(-1);
        setLevels({});
      }
    },
    [clip],
  );

  return { videoRef, clip, pos, levels, playing, play, stop };
}

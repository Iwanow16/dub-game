import { useCallback, useEffect, useRef, useState } from "react";
import { analyserLevel, type VoiceLayer } from "@dubroom/audio";
import type { CatalogEntry, Entry } from "@dubroom/shared";
import { audioContext, unlockAudio } from "./audio.ts";
import { loadClip, loadDub, type LoadedClip } from "./media.ts";
import { playOnStage, type Playback } from "./stage.ts";

/**
 * Plays entries (a clip + one or more dubs) on a stage. Loads the clip and prefetches all dubs as
 * soon as entries are known (§11.6: ~0.75 MB for 5 players, fits in the watch lead time).
 */
export function useEntryPlayer(clipEntry: CatalogEntry | null, entries: Entry[]) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playback = useRef<Playback | null>(null);
  const [clip, setClip] = useState<LoadedClip | null>(null);
  const [pos, setPos] = useState(-1);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => {
    if (!clipEntry) return;
    let alive = true;
    loadClip(clipEntry)
      .then((c) => alive && setClip(c))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [clipEntry]);

  const dubKey = entries.flatMap((e) => e.tracks.map((t) => t.dubId)).join(",");
  useEffect(() => {
    for (const id of dubKey.split(",").filter(Boolean)) loadDub(id).catch(() => {});
  }, [dubKey]);

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
        when,
        fromMs,
        onPosition: (ms) => {
          setPos(ms);
          const lv: Record<string, number> = {};
          pb?.mix.analysers.forEach((an, i) => (lv[voices[i]!.key] = analyserLevel(an)));
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

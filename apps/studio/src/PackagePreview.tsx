import { useEffect, useMemo, useRef, useState } from "react";
import { decode } from "@dubroom/audio";
import type { ClipVersion } from "./api.ts";
import { audioCtx } from "./audio.ts";
import { SubtitleOverlay } from "./SubtitleOverlay.tsx";

/**
 * Plays a processed package exactly like the game does: silent video + separately decoded bed,
 * with the line overlay — the moderator checks what players will get.
 */
export function PackagePreview({ version }: { version: ClipVersion }) {
  const m = version.manifest;
  const video = useRef<HTMLVideoElement>(null);
  const [pos, setPos] = useState(-1);
  const [bed, setBed] = useState<AudioBuffer | null>(null);
  const base = `/media/clips/${version.clipId}/v${version.version}/`;
  const rung = useMemo(() => {
    const el = document.createElement("video");
    const ok = (m?.media?.video ?? []).filter(
      (v) =>
        el.canPlayType(
          v.url.endsWith(".webm")
            ? `video/webm; codecs="${v.codec}"`
            : `video/mp4; codecs="${v.codec}"`,
        ) !== "",
    );
    return ok.find((v) => v.height === 480) ?? ok[0] ?? m?.media?.video[0];
  }, [m]);
  const opus = m?.media?.bed.find((b) => b.codec === "opus") ?? m?.media?.bed[0];

  useEffect(() => {
    if (!opus) return;
    fetch(base + opus.url)
      .then((r) => r.arrayBuffer())
      .then((b) => decode(audioCtx(), b))
      .then(setBed)
      .catch(() => setBed(null));
  }, [base, opus]);

  if (!m?.media || !rung) return <p className="dr-muted">Пакет ещё не собран.</p>;

  const play = async () => {
    const ctx = audioCtx();
    await ctx.resume();
    const v = video.current!;
    v.currentTime = 0;
    let src: AudioBufferSourceNode | null = null;
    if (bed) {
      src = ctx.createBufferSource();
      src.buffer = bed;
      src.connect(ctx.destination);
      src.start(ctx.currentTime + 0.05);
    }
    const t0 = ctx.currentTime + 0.05;
    await v.play();
    const tick = () => {
      const p = (ctx.currentTime - t0) * 1000;
      setPos(p);
      if (Math.abs(v.currentTime * 1000 - p) > 80) v.currentTime = p / 1000;
      if (p < m.durationMs && !v.paused) requestAnimationFrame(tick);
      else {
        src?.stop();
        setPos(-1);
      }
    };
    requestAnimationFrame(tick);
  };

  return (
    <div className="pkg-preview">
      <div className="player">
        <video ref={video} src={base + rung.url} poster={base + m.media.poster} muted playsInline />
        <SubtitleOverlay manifest={m} positionMs={pos} />
      </div>
      <div className="row">
        <button type="button" className="dr-btn dr-btn--small" onClick={() => void play()}>
          ▶ Как у игрока
        </button>
        <span className="dr-muted small">
          {m.media.video.map((v) => `${v.height}p ${(v.bytes / 1e6).toFixed(1)} МБ`).join(" · ")} ·
          фон {((opus?.bytes ?? 0) / 1e3).toFixed(0)} КБ
        </span>
      </div>
    </div>
  );
}

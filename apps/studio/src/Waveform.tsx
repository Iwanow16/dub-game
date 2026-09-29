import { useEffect, useRef } from "react";
import type { ClipManifest } from "@dubroom/clip-format";
import type { Peaks } from "./audio.ts";

export interface View {
  /** clip time at the left edge, ms */
  start: number;
  /** visible span, ms */
  span: number;
}

/**
 * Timeline (§20.3 Studio): voice waveform, line blocks and scene bands for the visible window of
 * the clip. Works the same for a 15-second clip and an hour-long episode: only the window is drawn,
 * from precomputed peaks. Click to seek; click a block/band to select it.
 */
export function Waveform({
  peaks,
  offsetMs,
  durationMs,
  view,
  lines,
  roles,
  scenes,
  selected,
  selectedScene,
  positionMs,
  onSeek,
  onSelect,
  onSelectScene,
}: {
  peaks: Peaks | null;
  /** where clip time 0 is inside the peaks (trim start), ms */
  offsetMs: number;
  durationMs: number;
  view: View;
  lines: ClipManifest["lines"];
  roles: ClipManifest["roles"];
  scenes: NonNullable<ClipManifest["scenes"]>;
  selected: string | null;
  selectedScene: string | null;
  positionMs: number;
  onSeek: (ms: number) => void;
  onSelect: (id: string) => void;
  onSelectScene: (id: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const end = view.start + view.span;

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    g.fillStyle = "#1c1c28";
    g.fillRect(0, 0, w, h);
    // time grid: a tick every 1/5/10/30/60 s depending on zoom
    const step =
      [1000, 5000, 10_000, 30_000, 60_000, 300_000].find((s) => view.span / s <= 20) ?? 600_000;
    g.fillStyle = "#33334d";
    for (let t = Math.ceil(view.start / step) * step; t < end; t += step) {
      g.fillRect(((t - view.start) / view.span) * w, 0, 1, h);
    }
    if (!peaks || durationMs <= 0) return;
    const mid = h / 2;
    g.fillStyle = "#6f7cff";
    for (let x = 0; x < w; x++) {
      // pairs covering this pixel column
      const t0 = offsetMs + view.start + (x / w) * view.span;
      const t1 = offsetMs + view.start + ((x + 1) / w) * view.span;
      const a = Math.floor((t0 / 1000) * peaks.perSec);
      const b = Math.max(a + 1, Math.floor((t1 / 1000) * peaks.perSec));
      let min = 0;
      let max = 0;
      for (let i = a; i < b && i * 2 + 1 < peaks.data.length; i++) {
        if (i < 0) continue;
        min = Math.min(min, peaks.data[i * 2]!);
        max = Math.max(max, peaks.data[i * 2 + 1]!);
      }
      g.fillRect(
        x,
        mid - (max / 128) * mid * 0.95,
        1,
        Math.max(1, ((max - min) / 128) * mid * 0.95),
      );
    }
  }, [peaks, offsetMs, durationMs, view.start, view.span, end]);

  const pct = (ms: number) =>
    `${((Math.max(view.start, Math.min(end, ms)) - view.start) / view.span) * 100}%`;
  const visible = <T extends { startMs: number; endMs: number }>(x: T) =>
    x.endMs > view.start && x.startMs < end;
  return (
    <div className="wave">
      <canvas
        ref={canvas}
        className="wave__canvas"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek(view.start + ((e.clientX - r.left) / r.width) * view.span);
        }}
      />
      {scenes.filter(visible).map((s) => (
        <button
          key={s.id}
          type="button"
          className={`wave__scene ${selectedScene === s.id ? "wave__scene--sel" : ""}`}
          style={{ left: pct(s.startMs), width: `calc(${pct(s.endMs)} - ${pct(s.startMs)})` }}
          title={`${s.id}: ${Math.round((s.endMs - s.startMs) / 1000)} с`}
          onClick={() => onSelectScene(s.id)}
        >
          {s.id}
          {s.title?.ru ? ` · ${s.title.ru}` : ""}
        </button>
      ))}
      {lines.filter(visible).map((l) => {
        const role = roles.find((r) => r.id === l.role);
        return (
          <button
            key={l.id}
            type="button"
            className={`wave__line ${selected === l.id ? "wave__line--sel" : ""}`}
            style={{
              left: pct(l.startMs),
              width: `calc(${pct(l.endMs)} - ${pct(l.startMs)})`,
              background: role?.color ?? "#888",
            }}
            title={`${l.id}: ${l.text.ru ?? ""}`}
            onClick={() => onSelect(l.id)}
          >
            {l.text.ru?.slice(0, 24)}
          </button>
        );
      })}
      {positionMs >= view.start && positionMs <= end && (
        <span className="wave__head" style={{ left: pct(positionMs) }} />
      )}
    </div>
  );
}

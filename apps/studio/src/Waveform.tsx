import { useEffect, useRef } from "react";
import type { ClipManifest } from "@dubroom/clip-format";
import { peaks } from "./audio.ts";

/**
 * Timeline (§20.3 Studio): waveform of the voice track with line blocks on top. Times are in clip
 * time (0 = trim start). Click to seek; click a block to select a line.
 */
export function Waveform({
  buffer,
  offsetMs,
  durationMs,
  lines,
  roles,
  selected,
  positionMs,
  onSeek,
  onSelect,
}: {
  buffer: AudioBuffer | null;
  /** where clip time 0 is inside the buffer (trim start), ms */
  offsetMs: number;
  durationMs: number;
  lines: ClipManifest["lines"];
  roles: ClipManifest["roles"];
  selected: string | null;
  positionMs: number;
  onSeek: (ms: number) => void;
  onSelect: (id: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

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
    g.clearRect(0, 0, w, h);
    g.fillStyle = "#1c1c28";
    g.fillRect(0, 0, w, h);
    if (buffer && durationMs > 0) {
      // slice of the buffer that corresponds to the trimmed clip
      const sr = buffer.sampleRate;
      const from = Math.floor((offsetMs / 1000) * sr);
      const len = Math.floor((durationMs / 1000) * sr);
      const sub = new AudioBuffer({
        length: Math.max(1, Math.min(len, buffer.length - from)),
        sampleRate: sr,
        numberOfChannels: 1,
      });
      sub.copyToChannel(buffer.getChannelData(0).subarray(from, from + sub.length), 0);
      const p = peaks(sub, w);
      g.fillStyle = "#6f7cff";
      const mid = h / 2;
      for (let x = 0; x < w; x++) {
        const min = p[x * 2]!;
        const max = p[x * 2 + 1]!;
        g.fillRect(x, mid - max * mid * 0.95, 1, Math.max(1, (max - min) * mid * 0.95));
      }
    }
  }, [buffer, offsetMs, durationMs]);

  const pct = (ms: number) => `${(ms / Math.max(1, durationMs)) * 100}%`;
  return (
    <div className="wave">
      <canvas
        ref={canvas}
        className="wave__canvas"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek(((e.clientX - r.left) / r.width) * durationMs);
        }}
      />
      {lines.map((l) => {
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
      <span className="wave__head" style={{ left: pct(Math.max(0, positionMs)) }} />
    </div>
  );
}

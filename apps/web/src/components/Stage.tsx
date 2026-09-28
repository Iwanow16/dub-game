import { forwardRef, type ReactNode } from "react";
import { localized } from "@dubroom/shared";
import type { Manifest } from "../lib/media.ts";
import { useLang } from "../lib/i18n.ts";

/**
 * Video stage (§20.1: video is the hero, ≥ 60 % of the height) with the line ticker overlay.
 */
export const Stage = forwardRef<
  HTMLVideoElement,
  {
    manifest?: Manifest | null;
    positionMs?: number;
    poster?: string;
    /** role ids voiced by the viewer — their lines are highlighted, others dimmed */
    myRoles?: string[] | null;
    showSubtitles?: boolean;
    /** improv mode (§3.2): timing cues only, no text */
    hideText?: boolean;
    overlay?: ReactNode;
  }
>(function Stage(
  { manifest, positionMs = -1, poster, myRoles, showSubtitles = true, hideText, overlay },
  ref,
) {
  return (
    <div className="stage">
      <video ref={ref} className="stage__video" playsInline muted preload="auto" poster={poster} />
      {manifest && showSubtitles && positionMs >= 0 && (
        <Ticker manifest={manifest} positionMs={positionMs} myRoles={myRoles} hideText={hideText} />
      )}
      {overlay}
    </div>
  );
});

function Ticker({
  manifest,
  positionMs,
  myRoles,
  hideText,
}: {
  manifest: Manifest;
  positionMs: number;
  myRoles?: string[] | null;
  hideText?: boolean;
}) {
  const lang = useLang((s) => s.lang);
  const lead = 1000; // highlight 1 s before the line starts (§20.3)
  const line = manifest.lines.find((l) => positionMs >= l.startMs - lead && positionMs <= l.endMs);
  if (!line) return null;
  const role = manifest.roles.find((r) => r.id === line.role);
  const upcoming = positionMs < line.startMs;
  const mine = !myRoles || myRoles.includes(line.role);
  const fill = upcoming
    ? (positionMs - (line.startMs - lead)) / lead
    : (positionMs - line.startMs) / Math.max(1, line.endMs - line.startMs);
  return (
    <div
      className={`dr-ticker ${upcoming ? "dr-ticker--upcoming" : ""} ${mine ? "" : "dr-ticker--other"}`}
      aria-live="off"
    >
      <span className="dr-ticker__who" style={{ color: role?.color }}>
        {role ? localized(role.name, lang) : ""}:
      </span>
      {hideText ? "🎤 …" : `«${localized(line.text, lang)}»`}
      {line.hint && !hideText && <span className="dr-ticker__hint">({line.hint})</span>}
      <span
        className="dr-ticker__bar"
        style={{
          width: `${Math.max(0, Math.min(1, fill)) * 100}%`,
          background: upcoming ? "var(--accent)" : role?.color,
        }}
      />
    </div>
  );
}

export function Countdown({ n }: { n: number }) {
  return (
    <div className="stage__countdown" aria-live="assertive">
      {n}
    </div>
  );
}

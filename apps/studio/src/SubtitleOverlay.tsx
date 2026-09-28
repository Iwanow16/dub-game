import type { ClipManifest } from "@dubroom/clip-format";

export function SubtitleOverlay({
  manifest,
  positionMs,
  lang = "ru",
}: {
  manifest: Pick<ClipManifest, "lines" | "roles">;
  positionMs: number;
  lang?: "ru" | "en";
}) {
  if (positionMs < 0) return null;
  const line = manifest.lines.find((l) => positionMs >= l.startMs && positionMs <= l.endMs);
  if (!line) return null;
  const role = manifest.roles.find((r) => r.id === line.role);
  return (
    <div className="dr-ticker">
      <span className="dr-ticker__who" style={{ color: role?.color }}>
        {role?.name[lang] ?? role?.name.ru ?? line.role}:
      </span>
      «{line.text[lang] ?? line.text.ru}»
      {line.hint && <span className="dr-ticker__hint">({line.hint})</span>}
    </div>
  );
}

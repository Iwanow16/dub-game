import type { ClipLine, ClipManifest } from "./manifest.ts";

export interface SrtCue {
  startMs: number;
  endMs: number;
  text: string;
}

function parseTimestamp(ts: string): number {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(ts.trim());
  if (!m) throw new Error(`bad timestamp: ${ts}`);
  const [, h, mi, s, ms] = m;
  return ((+h! * 60 + +mi!) * 60 + +s!) * 1000 + +ms!.padEnd(3, "0");
}

export function parseSrt(src: string): SrtCue[] {
  const blocks = src
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n{2,}/);
  const cues: SrtCue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const arrowAt = lines.findIndex((l) => l.includes("-->"));
    if (arrowAt < 0) continue;
    const [a, b] = lines[arrowAt]!.split("-->");
    cues.push({
      startMs: parseTimestamp(a!),
      endMs: parseTimestamp(b!.trim().split(/\s+/)[0]!),
      text: lines
        .slice(arrowAt + 1)
        .join(" ")
        .trim(),
    });
  }
  return cues;
}

/**
 * Converts SRT cues into manifest lines (§10, step 4). A cue may start with a role tag like "[r1]"
 * or "[Кот]"; roleMap maps free-form tags to role ids. Untagged cues go to `defaultRole`.
 * An optional trailing "(hint)" becomes the intonation hint.
 */
export function linesFromSrt(
  cues: SrtCue[],
  opts: { lang?: "ru" | "en"; roleMap?: Record<string, string>; defaultRole?: string } = {},
): ClipLine[] {
  const lang = opts.lang ?? "ru";
  return cues.map((cue, i) => {
    let text = cue.text;
    let role = opts.defaultRole ?? "r1";
    const tag = /^\[([^\]]+)\]\s*/.exec(text);
    if (tag) {
      const t = tag[1]!.trim();
      role = opts.roleMap?.[t] ?? t;
      text = text.slice(tag[0].length);
    }
    let hint: string | undefined;
    const h = /\s*\(([^)]{1,60})\)\s*$/.exec(text);
    if (h) {
      hint = h[1];
      text = text.slice(0, h.index);
    }
    return {
      id: `l${i + 1}`,
      role,
      startMs: cue.startMs,
      endMs: cue.endMs,
      text: { [lang]: text.trim() },
      ...(hint ? { hint } : {}),
    };
  });
}

function vttTime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}.${p(r, 3)}`;
}

/** WebVTT subtitles for one language, with the role name as a voice span. */
export function toVtt(m: ClipManifest, lang: "ru" | "en"): string {
  const roleName = new Map(m.roles.map((r) => [r.id, r.name[lang] ?? r.name.ru ?? r.id]));
  const cues = m.lines
    .filter((l) => l.text[lang] ?? l.text.ru)
    .sort((a, b) => a.startMs - b.startMs)
    .map((l) => {
      const text = (l.text[lang] ?? l.text.ru)!.replace(/</g, "&lt;");
      return `${l.id}\n${vttTime(l.startMs)} --> ${vttTime(l.endMs)}\n<v ${roleName.get(l.role)}>${text}`;
    });
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

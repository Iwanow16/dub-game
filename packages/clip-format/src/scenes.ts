import type { ClipLine, ClipScene } from "./manifest.ts";

/**
 * Scenes (ADR-0009): a long clip — a game trailer, a cut from a TV series — is played one scene per
 * round. A scene is a range of the clip timeline that no line crosses; the media worker cuts
 * small, fully preloadable media for every scene.
 */
export const SCENE_LIMITS = {
  minMs: 5_000,
  /** scenes are preloaded whole, so they stay below the client's streaming threshold */
  maxMs: 120_000,
  /** clips longer than this get automatic scenes when the author defined none */
  autoAboveMs: 90_000,
  targetMs: 45_000,
  /** keyframes every 2 s → scene starts on this grid are cut without re-encoding */
  gridMs: 2_000,
} as const;

/** Lines of a scene, re-timed so that 0 = scene start. */
export function sceneLines(
  lines: ClipLine[],
  scene: Pick<ClipScene, "startMs" | "endMs">,
): ClipLine[] {
  return lines
    .filter((l) => l.startMs >= scene.startMs && l.endMs <= scene.endMs)
    .map((l) => ({ ...l, startMs: l.startMs - scene.startMs, endMs: l.endMs - scene.startMs }));
}

export function sceneRoleCount(
  lines: ClipLine[],
  scene: Pick<ClipScene, "startMs" | "endMs">,
): number {
  return new Set(sceneLines(lines, scene).map((l) => l.role)).size;
}

interface Cut {
  at: number;
  /** silence around the cut, ms — bigger is a more natural scene break */
  gap: number;
  grid: boolean;
}

/**
 * Splits a clip into scenes at pauses between lines (never inside a line). Aims for `targetMs`,
 * stays within [minMs, maxMs] whenever the dialogue allows it, and prefers cut points on the 2 s
 * keyframe grid so the worker can cut without re-encoding.
 */
export function autoScenes(
  lines: Pick<ClipLine, "startMs" | "endMs">[],
  durationMs: number,
  opts: { targetMs?: number; minMs?: number; maxMs?: number } = {},
): { id: string; startMs: number; endMs: number }[] {
  const target = opts.targetMs ?? SCENE_LIMITS.targetMs;
  const min = opts.minMs ?? SCENE_LIMITS.minMs;
  const max = opts.maxMs ?? SCENE_LIMITS.maxMs;
  if (durationMs <= max) return [{ id: "s1", startMs: 0, endMs: durationMs }];

  // merge overlapping lines (different roles may overlap) into speech blocks
  const blocks: { start: number; end: number }[] = [];
  for (const l of [...lines].sort((a, b) => a.startMs - b.startMs)) {
    const last = blocks[blocks.length - 1];
    if (last && l.startMs <= last.end) last.end = Math.max(last.end, l.endMs);
    else blocks.push({ start: l.startMs, end: l.endMs });
  }
  // candidate cuts: in every pause, on the grid if possible, else in the middle
  const cuts: Cut[] = [];
  const pause = (from: number, to: number) => {
    const gap = to - from;
    if (gap <= 0) return;
    const g =
      Math.ceil((from + Math.min(400, gap / 2)) / SCENE_LIMITS.gridMs) * SCENE_LIMITS.gridMs;
    if (g <= to) cuts.push({ at: g, gap, grid: true });
    else cuts.push({ at: Math.round((from + to) / 2), gap, grid: false });
  };
  if (blocks.length === 0) {
    // no dialogue at all: plain grid cuts
    for (let t = target; t < durationMs; t += target)
      cuts.push({ at: t, gap: 0, grid: t % SCENE_LIMITS.gridMs === 0 });
  } else {
    pause(0, blocks[0]!.start);
    for (let i = 1; i < blocks.length; i++) pause(blocks[i - 1]!.end, blocks[i]!.start);
    pause(blocks[blocks.length - 1]!.end, durationMs);
  }

  const scenes: { id: string; startMs: number; endMs: number }[] = [];
  let start = 0;
  while (start < durationMs) {
    if (durationMs - start <= max) {
      scenes.push({ id: `s${scenes.length + 1}`, startMs: start, endMs: durationMs });
      break;
    }
    const inWindow = cuts.filter(
      (c) => c.at >= start + min && c.at <= start + max && c.at < durationMs,
    );
    let cut: Cut | undefined;
    if (inWindow.length) {
      // score: long pauses and landing near the target length; grid points are free to cut
      const score = (c: Cut) =>
        Math.min(c.gap, 3000) / 3000 - Math.abs(c.at - start - target) / max + (c.grid ? 0.15 : 0);
      cut = inWindow.reduce((a, b) => (score(b) > score(a) ? b : a));
    } else {
      // continuous speech longer than `max`: the first pause after it (a longer scene beats a cut line)
      cut = cuts.find((c) => c.at > start + max && c.at < durationMs);
    }
    if (!cut) {
      scenes.push({ id: `s${scenes.length + 1}`, startMs: start, endMs: durationMs });
      break;
    }
    // a too-short tail is merged into this scene
    const end = durationMs - cut.at < min ? durationMs : cut.at;
    scenes.push({ id: `s${scenes.length + 1}`, startMs: start, endMs: end });
    start = end;
  }
  return scenes;
}

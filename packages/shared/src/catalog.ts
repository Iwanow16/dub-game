import type { AgeRating } from "./game.ts";

export type LocalizedText = Partial<Record<"ru" | "en", string>>;

/**
 * A scene of a long clip: the unit a round is played on in "scenes" mode. Times are on the clip
 * timeline; every scene has its own small, fully preloadable media (see the clip manifest).
 */
export interface CatalogScene {
  id: string;
  startMs: number;
  endMs: number;
  title?: LocalizedText;
  rolesCount: number;
  /** roles that speak in this scene (for team assignment in roles mode) */
  roleIds: string[];
  posterUrl: string;
}

/** One row of catalog.json (§11.2) — enough to render a card and start preloading. */
export interface CatalogEntry {
  id: string;
  slug: string;
  version: number;
  title: LocalizedText;
  durationMs: number;
  rolesCount: number;
  ageRating: AgeRating;
  tags: string[];
  credit: string;
  /** absolute path (from site root) of the published manifest */
  manifestUrl: string;
  posterUrl: string;
  previewUrl: string | null;
  /** scenes of a long clip; empty for short clips that are always played whole */
  scenes: CatalogScene[];
}

/**
 * What a round is played on: a whole clip or one of its scenes. `id` is unique per playable
 * (`<clipId>` or `<clipId>#<sceneId>`); durationMs / rolesCount / posterUrl describe the part
 * that is actually played.
 */
export interface Playable extends CatalogEntry {
  clipId: string;
  scene: CatalogScene | null;
  /** 1-based index of the scene inside the clip, and how many there are */
  sceneIndex: number;
  sceneCount: number;
  /** full clip length, for "Scene 3/12 · 20 min clip" labels */
  clipDurationMs: number;
}

export type SegmentMode = "scene" | "full";

/**
 * Expands the catalog into playables. "scene" mode plays scenes of long clips (short clips stay
 * whole); "full" mode plays every clip from start to end, whatever its length.
 */
export function expandPlayables(catalog: CatalogEntry[], mode: SegmentMode): Playable[] {
  return catalog.flatMap((c): Playable[] => {
    const scenes = c.scenes ?? [];
    const whole: Playable = {
      ...c,
      clipId: c.id,
      scene: null,
      sceneIndex: 0,
      sceneCount: scenes.length,
      clipDurationMs: c.durationMs,
    };
    if (mode === "full" || scenes.length === 0) return [whole];
    return scenes.map((s, i) => ({
      ...c,
      id: `${c.id}#${s.id}`,
      clipId: c.id,
      scene: s,
      sceneIndex: i + 1,
      sceneCount: scenes.length,
      clipDurationMs: c.durationMs,
      durationMs: s.endMs - s.startMs,
      rolesCount: s.rolesCount,
      posterUrl: s.posterUrl,
    }));
  });
}

export interface Catalog {
  schema: "dubroom.catalog/1";
  generatedAt: string;
  clips: CatalogEntry[];
}

export function localized(text: LocalizedText, lang: string): string {
  return (text as Record<string, string | undefined>)[lang] ?? text.ru ?? text.en ?? "";
}

import type { AgeRating } from "./game.ts";

export type LocalizedText = Partial<Record<"ru" | "en", string>>;

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
}

export interface Catalog {
  schema: "dubroom.catalog/1";
  generatedAt: string;
  clips: CatalogEntry[];
}

export function localized(text: LocalizedText, lang: string): string {
  return (text as Record<string, string | undefined>)[lang] ?? text.ru ?? text.en ?? "";
}

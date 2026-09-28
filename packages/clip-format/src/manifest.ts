import { z } from "zod";
import { AGE_RATINGS } from "@dubroom/shared";

/** Clip package manifest, schema version 1 (§8.2). */
export const MANIFEST_SCHEMA = "dubroom.clip/1";

export const LocalizedTextSchema = z
  .object({ ru: z.string().max(200).optional(), en: z.string().max(200).optional() })
  .refine((t) => Boolean(t.ru?.trim() || t.en?.trim()), { message: "at least one language" });

export const RoleSchema = z.object({
  id: z.string().regex(/^r\d{1,2}$/, "role id must look like r1, r2 …"),
  name: LocalizedTextSchema,
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
});

export const LineSchema = z.object({
  id: z.string().regex(/^l\d{1,4}$/, "line id must look like l1, l2 …"),
  role: z.string(),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  text: LocalizedTextSchema,
  hint: z.string().max(60).optional(),
});

const MediaFileSchema = z.object({
  url: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  codec: z.string(),
});

export const MediaSchema = z.object({
  video: z.array(MediaFileSchema.extend({ height: z.number().int().positive() })).min(1),
  bed: z.array(MediaFileSchema).min(1),
  originalVoice: MediaFileSchema.optional(),
  poster: z.string(),
  preview: z.string().nullable(),
  subtitles: z.record(z.string()).optional(),
});

export const ManifestSchema = z.object({
  schema: z.literal(MANIFEST_SCHEMA),
  id: z.string().regex(/^c_[a-z0-9]{6,32}$/),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug: lowercase latin, digits and dashes"),
  version: z.number().int().min(1),
  title: LocalizedTextSchema,
  description: LocalizedTextSchema.optional(),
  durationMs: z.number().int().positive(),
  ageRating: z.enum(AGE_RATINGS),
  tags: z.array(z.string().min(1).max(30)).max(10),
  credit: z.string(),
  license: z.string(),
  roles: z.array(RoleSchema).min(1).max(6),
  lines: z.array(LineSchema),
  /** Trim of the source, applied by the media worker. */
  source: z
    .object({
      video: z.string().optional(),
      bed: z.string().optional(),
      dialogue: z.string().optional(),
      trimStartMs: z.number().int().min(0).optional(),
      trimEndMs: z.number().int().min(0).optional(),
    })
    .optional(),
  media: MediaSchema.optional(),
  sync: z.object({
    leadInMs: z.number().int().min(0).max(10_000),
    videoAudioOffsetMs: z.number().int().min(-1000).max(1000),
  }),
  checksums: z.object({ algo: z.literal("sha256"), files: z.record(z.string()) }).optional(),
});

export type ClipManifest = z.infer<typeof ManifestSchema>;
export type ClipRole = z.infer<typeof RoleSchema>;
export type ClipLine = z.infer<typeof LineSchema>;
export type ClipMedia = z.infer<typeof MediaSchema>;

/** Six colour-blind-distinguishable role colours (§20.4). */
export const ROLE_COLORS = ["#FF8A3D", "#3DA5FF", "#3DDC97", "#FF6FB5", "#FFC23D", "#B37BFF"];

export const KNOWN_LICENSES = [
  "CC0 1.0",
  "CC BY 4.0",
  "CC BY 3.0",
  "CC BY-SA 4.0",
  "Public Domain",
  "Own work",
  "Written permission",
];

export function newClipId(rand: () => number = Math.random): string {
  let s = "c_";
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 12; i++) s += a[Math.floor(rand() * a.length)];
  return s;
}

export function emptyManifest(partial: Partial<ClipManifest> = {}): ClipManifest {
  return {
    schema: MANIFEST_SCHEMA,
    id: newClipId(),
    slug: "new-clip",
    version: 1,
    title: { ru: "Новый клип" },
    durationMs: 1000,
    ageRating: "12+",
    tags: [],
    credit: "",
    license: "",
    roles: [{ id: "r1", name: { ru: "Роль 1" }, color: ROLE_COLORS[0]! }],
    lines: [],
    sync: { leadInMs: 3000, videoAudioOffsetMs: 0 },
    ...partial,
  };
}

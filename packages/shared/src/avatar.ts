import { z } from "zod";

/**
 * Compact avatar description (§5.2): layered SVG parts, rendered on the client.
 * Serialized form stays well under 100 bytes.
 */
export const AVATAR_PARTS = {
  /** head shape */
  b: 6,
  /** eyes */
  e: 8,
  /** mouth */
  m: 6,
  /** hair */
  h: 10,
  /** accessory (0 = none) */
  a: 7,
  /** background pattern */
  g: 6,
} as const;

export const SKIN_COLORS = [
  "#FFDBB4",
  "#F1C27D",
  "#E0AC69",
  "#C68642",
  "#8D5524",
  "#5C3A1E",
] as const;
export const AVATAR_COLORS = [
  "#FFC23D",
  "#FF4D5E",
  "#3DDC97",
  "#3DA5FF",
  "#B37BFF",
  "#FF8A3D",
  "#FF6FB5",
  "#00C2C7",
] as const;

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const AvatarSpecSchema = z.object({
  v: z.literal(1),
  b: z
    .number()
    .int()
    .min(0)
    .max(AVATAR_PARTS.b - 1),
  e: z
    .number()
    .int()
    .min(0)
    .max(AVATAR_PARTS.e - 1),
  m: z
    .number()
    .int()
    .min(0)
    .max(AVATAR_PARTS.m - 1),
  h: z
    .number()
    .int()
    .min(0)
    .max(AVATAR_PARTS.h - 1),
  a: z
    .number()
    .int()
    .min(0)
    .max(AVATAR_PARTS.a - 1),
  g: z
    .number()
    .int()
    .min(0)
    .max(AVATAR_PARTS.g - 1),
  s: z
    .number()
    .int()
    .min(0)
    .max(SKIN_COLORS.length - 1),
  c: hex,
});
export type AvatarSpec = z.infer<typeof AvatarSpecSchema>;

export type AvatarPart = keyof typeof AVATAR_PARTS;

export function randomAvatar(rand: () => number = Math.random): AvatarSpec {
  const pick = (n: number) => Math.floor(rand() * n);
  return {
    v: 1,
    b: pick(AVATAR_PARTS.b),
    e: pick(AVATAR_PARTS.e),
    m: pick(AVATAR_PARTS.m),
    h: pick(AVATAR_PARTS.h),
    a: pick(AVATAR_PARTS.a),
    g: pick(AVATAR_PARTS.g),
    s: pick(SKIN_COLORS.length),
    c: AVATAR_COLORS[pick(AVATAR_COLORS.length)]!,
  };
}

/** 24 ready-made presets, deterministic so every client shows the same set. */
export const AVATAR_PRESETS: AvatarSpec[] = Array.from({ length: 24 }, (_, i) => {
  // small LCG seeded by index — stable across builds
  let seed = (i + 1) * 2654435761;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  return randomAvatar(rand);
});

/**
 * Player name rules (US-1): 2–20 characters, profanity filter, uniqueness inside a room.
 */
export const NAME_MIN = 2;
export const NAME_MAX = 20;

// Roots are matched against a normalized form (lowercase, look-alike latin → cyrillic folded,
// repeated letters collapsed), so simple obfuscations like "Хууууй" or "xуй" are caught too.
const BANNED_ROOTS = [
  // RU
  "хуй",
  "хуе",
  "хуё",
  "пизд",
  "ебат",
  "ебан",
  "ёбан",
  "ебал",
  "бляд",
  "блят",
  "сука",
  "мудак",
  "пидор",
  "пидар",
  "залуп",
  "шлюх",
  "гандон",
  "долбоеб",
  "уебок",
  "уёбок",
  // EN
  "fuck",
  "shit",
  "cunt",
  "bitch",
  "nigger",
  "nigga",
  "faggot",
  "whore",
  "dick",
  "pussy",
  "asshole",
];

const LOOKALIKES: Record<string, string> = {
  a: "а",
  e: "е",
  o: "о",
  p: "р",
  c: "с",
  y: "у",
  x: "х",
  k: "к",
  m: "м",
  t: "т",
  b: "б",
  "3": "з",
  "0": "о",
  "@": "а",
  "6": "б",
};

function normalizeForFilter(s: string, foldLatin: boolean): string {
  let out = s.toLowerCase().replace(/[\s._\-*]+/g, "");
  if (foldLatin) out = [...out].map((ch) => LOOKALIKES[ch] ?? ch).join("");
  return out.replace(/(.)\1+/g, "$1");
}

export function containsProfanity(s: string): boolean {
  const plain = normalizeForFilter(s, false);
  const folded = normalizeForFilter(s, true);
  return BANNED_ROOTS.some((root) => {
    const r = root.replace(/(.)\1+/g, "$1");
    return plain.includes(r) || folded.includes(normalizeForFilter(r, true));
  });
}

export type NameCheck = { ok: true; name: string } | { ok: false; error: "length" | "profanity" };

/** Trims, collapses whitespace, strips control characters, then validates. */
export function sanitizeName(raw: string): NameCheck {
  const name = raw.replace(/\p{C}/gu, "").replace(/\s+/g, " ").trim();
  const len = [...name].length;
  if (len < NAME_MIN || len > NAME_MAX) return { ok: false, error: "length" };
  if (containsProfanity(name)) return { ok: false, error: "profanity" };
  return { ok: true, name };
}

/** "Аня" → "Аня 2" if taken (case-insensitive), keeping the result within NAME_MAX. */
export function uniquifyName(name: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map((n) => n.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const suffix = ` ${i}`;
    const base = [...name].slice(0, NAME_MAX - suffix.length).join("");
    const candidate = base + suffix;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

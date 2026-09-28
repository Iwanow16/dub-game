import { useId, type ReactNode } from "react";
import {
  AVATAR_COLORS,
  AVATAR_PARTS,
  SKIN_COLORS,
  type AvatarSpec,
  type AvatarPart,
} from "@dubroom/shared";

/**
 * Layered SVG avatar (§5.2). `mouthOpen` (0..1) animates the mouth while the player's dub plays.
 */
export function Avatar({
  spec,
  size = 64,
  mouthOpen = 0,
  title,
}: {
  spec: AvatarSpec;
  size?: number;
  mouthOpen?: number;
  title?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const skin = SKIN_COLORS[spec.s] ?? SKIN_COLORS[0];
  const bg = spec.c;
  const dark = "#1c1c28";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={title ?? "аватар"}
      style={{ display: "block", borderRadius: "50%" }}
    >
      <defs>
        <clipPath id={`c${uid}`}>
          <circle cx="50" cy="50" r="50" />
        </clipPath>
      </defs>
      <g clipPath={`url(#c${uid})`}>
        <rect width="100" height="100" fill={bg} />
        {background(spec.g)}
        {head(spec.b, skin)}
        {hairBack(spec.h, dark)}
        {eyes(spec.e, dark)}
        {mouth(spec.m, mouthOpen, dark)}
        {hairFront(spec.h, dark, bg)}
        {accessory(spec.a, dark)}
      </g>
    </svg>
  );
}

function background(g: number): ReactNode {
  const light = "rgba(255,255,255,0.18)";
  switch (g) {
    case 1:
      return Array.from({ length: 6 }, (_, i) => (
        <rect
          key={i}
          x={i * 20 - 10}
          y="0"
          width="8"
          height="100"
          fill={light}
          transform="rotate(20 50 50)"
        />
      ));
    case 2:
      return Array.from({ length: 25 }, (_, i) => (
        <circle key={i} cx={(i % 5) * 22 + 6} cy={Math.floor(i / 5) * 22 + 6} r="3" fill={light} />
      ));
    case 3:
      return <circle cx="50" cy="110" r="60" fill={light} />;
    case 4:
      return <path d="M0 70 Q25 55 50 70 T100 70 V100 H0Z" fill={light} />;
    case 5:
      return (
        <polygon
          points="50,0 61,35 100,35 68,57 80,95 50,72 20,95 32,57 0,35 39,35"
          fill={light}
          opacity="0.6"
        />
      );
    default:
      return null;
  }
}

function head(b: number, skin: string): ReactNode {
  const neck = <rect x="40" y="72" width="20" height="30" fill={skin} />;
  const shapes = [
    <circle key="h" cx="50" cy="52" r="28" fill={skin} />,
    <rect key="h" x="22" y="24" width="56" height="58" rx="18" fill={skin} />,
    <ellipse key="h" cx="50" cy="52" rx="24" ry="31" fill={skin} />,
    <path
      key="h"
      d="M50 20 C75 20 80 45 78 60 C75 80 62 86 50 86 C38 86 25 80 22 60 C20 45 25 20 50 20Z"
      fill={skin}
    />,
    <polygon key="h" points="50,20 78,36 78,68 50,84 22,68 22,36" fill={skin} />,
    <path key="h" d="M24 40 Q24 20 50 20 Q76 20 76 40 L72 74 Q50 90 28 74Z" fill={skin} />,
  ];
  return (
    <>
      {neck}
      {shapes[b % shapes.length]}
    </>
  );
}

function eyes(e: number, ink: string): ReactNode {
  const L = 39;
  const R = 61;
  const y = 48;
  switch (e) {
    case 1:
      return (
        <>
          <circle cx={L} cy={y} r="6" fill="#fff" />
          <circle cx={R} cy={y} r="6" fill="#fff" />
          <circle cx={L + 1} cy={y + 1} r="3" fill={ink} />
          <circle cx={R + 1} cy={y + 1} r="3" fill={ink} />
        </>
      );
    case 2:
      return (
        <>
          <path
            d={`M${L - 5} ${y} Q${L} ${y - 6} ${L + 5} ${y}`}
            stroke={ink}
            strokeWidth="3"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d={`M${R - 5} ${y} Q${R} ${y - 6} ${R + 5} ${y}`}
            stroke={ink}
            strokeWidth="3"
            fill="none"
            strokeLinecap="round"
          />
        </>
      );
    case 3:
      return (
        <>
          <rect x={L - 5} y={y - 2} width="10" height="4" rx="2" fill={ink} />
          <rect x={R - 5} y={y - 2} width="10" height="4" rx="2" fill={ink} />
        </>
      );
    case 4:
      return (
        <>
          <circle cx={L} cy={y} r="7" fill="#fff" stroke={ink} strokeWidth="1.5" />
          <circle cx={R} cy={y} r="7" fill="#fff" stroke={ink} strokeWidth="1.5" />
          <circle cx={L} cy={y} r="4" fill="#3da5ff" />
          <circle cx={R} cy={y} r="4" fill="#3da5ff" />
          <circle cx={L} cy={y} r="2" fill={ink} />
          <circle cx={R} cy={y} r="2" fill={ink} />
        </>
      );
    case 5:
      return (
        <>
          <path
            d={`M${L - 5} ${y - 3} L${L + 5} ${y + 3} M${L + 5} ${y - 3} L${L - 5} ${y + 3}`}
            stroke={ink}
            strokeWidth="3"
            strokeLinecap="round"
          />
          <circle cx={R} cy={y} r="3.5" fill={ink} />
        </>
      );
    case 6:
      return (
        <>
          <path d={`M${L - 6} ${y + 2} Q${L} ${y - 5} ${L + 6} ${y + 2}Z`} fill={ink} />
          <path d={`M${R - 6} ${y + 2} Q${R} ${y - 5} ${R + 6} ${y + 2}Z`} fill={ink} />
        </>
      );
    case 7:
      return (
        <>
          <circle cx={L} cy={y} r="5" fill={ink} />
          <circle cx={R} cy={y} r="5" fill={ink} />
          <circle cx={L + 2} cy={y - 2} r="1.8" fill="#fff" />
          <circle cx={R + 2} cy={y - 2} r="1.8" fill="#fff" />
        </>
      );
    default:
      return (
        <>
          <circle cx={L} cy={y} r="3.5" fill={ink} />
          <circle cx={R} cy={y} r="3.5" fill={ink} />
        </>
      );
  }
}

function mouth(m: number, open: number, ink: string): ReactNode {
  const y = 66;
  if (open > 0.08) {
    const h = 3 + open * 12;
    return (
      <g>
        <ellipse cx="50" cy={y + h / 3} rx={8 + open * 3} ry={h / 2} fill="#5a1520" />
        <ellipse cx="50" cy={y + h / 1.6} rx={5} ry={Math.max(1, h / 5)} fill="#ff6f7d" />
      </g>
    );
  }
  switch (m) {
    case 1:
      return <path d={`M40 ${y} Q50 ${y + 10} 60 ${y}Z`} fill="#5a1520" />;
    case 2:
      return (
        <line
          x1="42"
          y1={y + 2}
          x2="58"
          y2={y + 2}
          stroke={ink}
          strokeWidth="3"
          strokeLinecap="round"
        />
      );
    case 3:
      return <circle cx="50" cy={y + 2} r="4" fill="#5a1520" />;
    case 4:
      return (
        <path
          d={`M42 ${y + 4} Q50 ${y - 3} 58 ${y + 4}`}
          stroke={ink}
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
        />
      );
    case 5:
      return (
        <>
          <path
            d={`M40 ${y} Q50 ${y + 9} 60 ${y}`}
            stroke={ink}
            strokeWidth="3"
            fill="none"
            strokeLinecap="round"
          />
          <rect
            x="52"
            y={y + 2}
            width="5"
            height="5"
            rx="1"
            fill="#fff"
            stroke={ink}
            strokeWidth="0.8"
          />
        </>
      );
    default:
      return (
        <path
          d={`M41 ${y} Q50 ${y + 8} 59 ${y}`}
          stroke={ink}
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
        />
      );
  }
}

function hairBack(h: number, ink: string): ReactNode {
  if (h === 4) return <path d="M20 45 Q18 90 30 95 L70 95 Q82 90 80 45Z" fill={ink} />;
  if (h === 8)
    return <path d="M22 40 Q14 80 24 92 L34 60Z M78 40 Q86 80 76 92 L66 60Z" fill="#b5651d" />;
  return null;
}

function hairFront(h: number, ink: string, accent: string): ReactNode {
  switch (h) {
    case 1:
      return <path d="M22 44 Q22 18 50 18 Q78 18 78 44 Q66 30 50 32 Q34 30 22 44Z" fill={ink} />;
    case 2:
      return Array.from({ length: 7 }, (_, i) => (
        <polygon key={i} points={`${24 + i * 8},36 ${28 + i * 8},14 ${32 + i * 8},36`} fill={ink} />
      ));
    case 3:
      return <path d="M24 38 Q30 16 56 18 Q80 22 76 42 Q60 26 24 38Z" fill="#e2b33c" />;
    case 4:
      return <path d="M22 44 Q22 18 50 18 Q78 18 78 44 L78 30 Q50 26 22 30Z" fill={ink} />;
    case 5:
      return (
        <>
          <circle cx="30" cy="26" r="9" fill={ink} />
          <circle cx="44" cy="20" r="10" fill={ink} />
          <circle cx="58" cy="20" r="10" fill={ink} />
          <circle cx="71" cy="27" r="9" fill={ink} />
        </>
      );
    case 6:
      return (
        <rect
          x="44"
          y="6"
          width="12"
          height="26"
          rx="4"
          fill={accent}
          stroke={ink}
          strokeWidth="2"
        />
      );
    case 7:
      return <path d="M22 40 Q50 4 78 40 Q70 24 50 24 Q30 24 22 40Z" fill="#c0392b" />;
    case 8:
      return <path d="M22 42 Q24 18 50 18 Q76 18 78 42 Q60 28 22 42Z" fill="#b5651d" />;
    case 9:
      return (
        <>
          <path d="M22 44 Q22 18 50 18 Q78 18 78 44 Q66 30 50 32 Q34 30 22 44Z" fill="#8e44ad" />
          <circle cx="50" cy="14" r="7" fill="#8e44ad" />
        </>
      );
    default:
      return null;
  }
}

function accessory(a: number, ink: string): ReactNode {
  switch (a) {
    case 1:
      return (
        <g fill="none" stroke={ink} strokeWidth="2.5">
          <circle cx="39" cy="48" r="8" />
          <circle cx="61" cy="48" r="8" />
          <line x1="47" y1="48" x2="53" y2="48" />
        </g>
      );
    case 2:
      return (
        <g>
          <rect x="29" y="42" width="18" height="10" rx="3" fill={ink} />
          <rect x="53" y="42" width="18" height="10" rx="3" fill={ink} />
          <line x1="47" y1="46" x2="53" y2="46" stroke={ink} strokeWidth="2" />
        </g>
      );
    case 3:
      return (
        <g>
          <rect x="20" y="16" width="60" height="12" rx="3" fill="#2c3e50" />
          <rect x="30" y="4" width="40" height="16" rx="4" fill="#2c3e50" />
        </g>
      );
    case 4:
      return <path d="M42 60 Q50 56 58 60 Q54 64 50 62 Q46 64 42 60Z" fill={ink} />;
    case 5:
      return (
        <g fill="none" stroke={ink} strokeWidth="3">
          <path d="M20 50 Q20 20 50 20 Q80 20 80 50" />
          <rect x="14" y="44" width="10" height="16" rx="4" fill={ink} />
          <rect x="76" y="44" width="10" height="16" rx="4" fill={ink} />
        </g>
      );
    case 6:
      return (
        <polygon
          points="30,24 38,8 46,20 50,4 54,20 62,8 70,24"
          fill="#ffc23d"
          stroke={ink}
          strokeWidth="1.5"
        />
      );
    default:
      return null;
  }
}

const PART_LABELS: Record<AvatarPart, { ru: string; en: string }> = {
  b: { ru: "Голова", en: "Head" },
  h: { ru: "Причёска", en: "Hair" },
  e: { ru: "Глаза", en: "Eyes" },
  a: { ru: "Аксессуар", en: "Accessory" },
  m: { ru: "Рот", en: "Mouth" },
  g: { ru: "Фон", en: "Background" },
};

/** Avatar constructor (§20.3 "Профиль"): arrows per part, skin and colour swatches. */
export function AvatarEditor({
  value,
  onChange,
  lang = "ru",
}: {
  value: AvatarSpec;
  onChange: (v: AvatarSpec) => void;
  lang?: "ru" | "en";
}) {
  const step = (part: AvatarPart, d: number) => {
    const n = AVATAR_PARTS[part];
    onChange({ ...value, [part]: (value[part] + d + n) % n });
  };
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))",
          gap: 8,
        }}
      >
        {(Object.keys(PART_LABELS) as AvatarPart[]).map((part) => (
          <div key={part} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ flex: 1 }}>{PART_LABELS[part][lang]}</span>
            <button
              type="button"
              className="dr-btn dr-btn--small dr-btn--icon"
              aria-label={`${PART_LABELS[part][lang]} ◀`}
              onClick={() => step(part, -1)}
            >
              ◀
            </button>
            <span aria-live="polite" style={{ minWidth: "2ch", textAlign: "center" }}>
              {value[part] + 1}
            </span>
            <button
              type="button"
              className="dr-btn dr-btn--small dr-btn--icon"
              aria-label={`${PART_LABELS[part][lang]} ▶`}
              onClick={() => step(part, 1)}
            >
              ▶
            </button>
          </div>
        ))}
      </div>
      <Swatches
        label={lang === "ru" ? "Кожа" : "Skin"}
        colors={SKIN_COLORS}
        selected={SKIN_COLORS[value.s]!}
        onPick={(_, i) => onChange({ ...value, s: i })}
      />
      <Swatches
        label={lang === "ru" ? "Цвет" : "Colour"}
        colors={AVATAR_COLORS}
        selected={value.c}
        onPick={(c) => onChange({ ...value, c })}
      />
    </div>
  );
}

function Swatches({
  label,
  colors,
  selected,
  onPick,
}: {
  label: string;
  colors: readonly string[];
  selected: string;
  onPick: (c: string, i: number) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}
    >
      <span style={{ minWidth: 80 }}>{label}</span>
      {colors.map((c, i) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c === selected}
          aria-label={c}
          onClick={() => onPick(c, i)}
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: c,
            border: c === selected ? "3px solid var(--text)" : "2px solid var(--border)",
            cursor: "pointer",
          }}
        />
      ))}
    </div>
  );
}

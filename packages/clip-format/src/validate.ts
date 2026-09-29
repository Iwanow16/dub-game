import { KNOWN_LICENSES, ManifestSchema, type ClipManifest } from "./manifest.ts";
import { SCENE_LIMITS } from "./scenes.ts";

export interface Issue {
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  manifest: ClipManifest | null;
  errors: Issue[];
  warnings: Issue[];
}

export const LIMITS = {
  minDurationMs: 5_000,
  /** default cap; servers override it with CLIP_MAX_MINUTES (any length is fine, see ADR-0009) */
  maxDurationMs: 3 * 3600_000,
  recommendedMinMs: 10_000,
  minLineMs: 300,
} as const;

const fmtDuration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} мин ${s % 60} с` : `${(ms / 1000).toFixed(1)} с`;
};

/**
 * Structural (schema) + semantic checks from §9.3 that do not need the media files.
 * Media-level checks (residual voice, loudness, black frames, resolution) run in the media worker.
 */
export function validateManifest(
  input: unknown,
  opts: { requireMedia?: boolean; maxDurationMs?: number } = {},
): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const parsed = ManifestSchema.safeParse(input);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      errors.push({ code: "schema", path: i.path.join("."), message: i.message });
    }
    return { ok: false, manifest: null, errors, warnings };
  }
  const m = parsed.data;

  const maxDuration = opts.maxDurationMs ?? LIMITS.maxDurationMs;
  if (m.durationMs < LIMITS.minDurationMs || m.durationMs > maxDuration) {
    errors.push({
      code: "duration",
      path: "durationMs",
      message: `длительность должна быть от 5 с до ${fmtDuration(maxDuration)}, сейчас ${fmtDuration(m.durationMs)}`,
    });
  } else if (m.durationMs < LIMITS.recommendedMinMs) {
    warnings.push({
      code: "duration_recommended",
      path: "durationMs",
      message: "клип короче 10 с — игрокам почти нечего озвучить",
    });
  } else if (m.durationMs > SCENE_LIMITS.autoAboveMs && !m.scenes?.length) {
    warnings.push({
      code: "scenes_auto",
      path: "scenes",
      message: `длинный клип (${fmtDuration(m.durationMs)}): в режиме «сцены» он будет разбит на сцены автоматически — проверьте границы на шаге «Сцены»`,
    });
  }

  if (!m.credit.trim())
    errors.push({ code: "credit", path: "credit", message: "укажите источник" });
  if (!m.license.trim()) {
    errors.push({ code: "license", path: "license", message: "укажите лицензию" });
  } else if (!KNOWN_LICENSES.includes(m.license)) {
    warnings.push({
      code: "license_unknown",
      path: "license",
      message: `нестандартная лицензия «${m.license}» — проверьте права вручную`,
    });
  }

  const roleIds = new Set<string>();
  m.roles.forEach((r, i) => {
    if (roleIds.has(r.id))
      errors.push({ code: "role_dup", path: `roles.${i}`, message: `роль ${r.id} повторяется` });
    roleIds.add(r.id);
  });

  if (m.lines.length === 0) {
    errors.push({ code: "no_lines", path: "lines", message: "нужна хотя бы одна реплика" });
  }

  const lineIds = new Set<string>();
  m.lines.forEach((l, i) => {
    const path = `lines.${i}`;
    if (lineIds.has(l.id))
      errors.push({ code: "line_dup", path, message: `реплика ${l.id} повторяется` });
    lineIds.add(l.id);
    if (!roleIds.has(l.role)) {
      errors.push({
        code: "line_role",
        path,
        message: `реплика ${l.id}: неизвестная роль ${l.role}`,
      });
    }
    if (l.endMs <= l.startMs) {
      errors.push({ code: "line_order", path, message: `реплика ${l.id}: конец раньше начала` });
    } else if (l.endMs - l.startMs < LIMITS.minLineMs) {
      warnings.push({ code: "line_short", path, message: `реплика ${l.id} короче 0.3 с` });
    }
    if (l.endMs > m.durationMs) {
      errors.push({ code: "line_bounds", path, message: `реплика ${l.id} выходит за конец клипа` });
    }
  });

  // lines must not overlap within one role
  for (const role of roleIds) {
    const lines = m.lines.filter((l) => l.role === role).sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.startMs < lines[i - 1]!.endMs) {
        errors.push({
          code: "line_overlap",
          path: "lines",
          message: `реплики ${lines[i - 1]!.id} и ${lines[i]!.id} роли ${role} пересекаются`,
        });
      }
    }
  }

  const unused = m.roles.filter((r) => !m.lines.some((l) => l.role === r.id));
  for (const r of unused) {
    warnings.push({ code: "role_unused", path: "roles", message: `у роли ${r.id} нет реплик` });
  }

  // scenes (ADR-0009): ordered, non-overlapping, playable length, no line crosses a boundary
  const scenes = [...(m.scenes ?? [])].sort((a, b) => a.startMs - b.startMs);
  const sceneIds = new Set<string>();
  scenes.forEach((sc, i) => {
    const path = `scenes.${sc.id}`;
    if (sceneIds.has(sc.id))
      errors.push({ code: "scene_dup", path, message: `сцена ${sc.id} повторяется` });
    sceneIds.add(sc.id);
    const len = sc.endMs - sc.startMs;
    if (len <= 0) {
      errors.push({ code: "scene_order", path, message: `сцена ${sc.id}: конец раньше начала` });
      return;
    }
    if (sc.endMs > m.durationMs) {
      errors.push({ code: "scene_bounds", path, message: `сцена ${sc.id} выходит за конец клипа` });
    }
    if (len < SCENE_LIMITS.minMs || len > SCENE_LIMITS.maxMs) {
      errors.push({
        code: "scene_length",
        path,
        message: `сцена ${sc.id}: ${fmtDuration(len)} — нужно от 5 с до 2 мин`,
      });
    }
    const prev = scenes[i - 1];
    if (prev && sc.startMs < prev.endMs) {
      errors.push({
        code: "scene_overlap",
        path,
        message: `сцены ${prev.id} и ${sc.id} пересекаются`,
      });
    }
    for (const l of m.lines) {
      const crosses =
        l.startMs < sc.endMs &&
        l.endMs > sc.startMs &&
        (l.startMs < sc.startMs || l.endMs > sc.endMs);
      if (crosses) {
        errors.push({
          code: "scene_cuts_line",
          path,
          message: `граница сцены ${sc.id} разрезает реплику ${l.id} — сдвиньте границу в паузу`,
        });
      }
    }
    if (!m.lines.some((l) => l.startMs >= sc.startMs && l.endMs <= sc.endMs)) {
      warnings.push({ code: "scene_empty", path, message: `в сцене ${sc.id} нет реплик` });
    }
  });
  if (scenes.length) {
    const outside = m.lines.filter(
      (l) => !scenes.some((sc) => l.startMs >= sc.startMs && l.endMs <= sc.endMs),
    );
    if (outside.length) {
      warnings.push({
        code: "lines_outside_scenes",
        path: "scenes",
        message: `реплик вне сцен: ${outside.length} — в режиме «сцены» они не прозвучат`,
      });
    }
  }

  if (opts.requireMedia && !m.media) {
    errors.push({ code: "media", path: "media", message: "нет блока media — пакет не обработан" });
  }

  return { ok: errors.length === 0, manifest: m, errors, warnings };
}

import { KNOWN_LICENSES, ManifestSchema, type ClipManifest } from "./manifest.ts";

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
  maxDurationMs: 90_000,
  recommendedMinMs: 10_000,
  recommendedMaxMs: 60_000,
  minLineMs: 300,
} as const;

/**
 * Structural (schema) + semantic checks from §9.3 that do not need the media files.
 * Media-level checks (residual voice, loudness, black frames, resolution) run in the media worker.
 */
export function validateManifest(
  input: unknown,
  opts: { requireMedia?: boolean } = {},
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

  if (m.durationMs < LIMITS.minDurationMs || m.durationMs > LIMITS.maxDurationMs) {
    errors.push({
      code: "duration",
      path: "durationMs",
      message: `длительность должна быть 5–90 с, сейчас ${(m.durationMs / 1000).toFixed(1)} с`,
    });
  } else if (m.durationMs < LIMITS.recommendedMinMs || m.durationMs > LIMITS.recommendedMaxMs) {
    warnings.push({
      code: "duration_recommended",
      path: "durationMs",
      message: "рекомендуемая длительность клипа — 10–60 с",
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

  if (opts.requireMedia && !m.media) {
    errors.push({ code: "media", path: "media", message: "нет блока media — пакет не обработан" });
  }

  return { ok: errors.length === 0, manifest: m, errors, warnings };
}

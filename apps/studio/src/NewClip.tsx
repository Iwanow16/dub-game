import { useState } from "react";
import { KNOWN_LICENSES, emptyManifest } from "@dubroom/clip-format";
import { AGE_RATINGS, type AgeRating } from "@dubroom/shared";
import { Button, useToast } from "@dubroom/ui";
import { api, uploadSource, type SourceKind } from "./api.ts";
import { probeDuration, setLocalFile } from "./localFiles.ts";

const MAX_BYTES = 2 * 1024 ** 3;
const VIDEO_TYPES = ".mp4,.mov,.mkv,video/mp4,video/quicktime,video/x-matroska";
const AUDIO_TYPES = ".wav,.flac,.mp3,.m4a,.ogg,.opus,audio/*";

export function slugify(s: string): string {
  const tr: Record<string, string> = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "e",
    ж: "zh",
    з: "z",
    и: "i",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "h",
    ц: "c",
    ч: "ch",
    ш: "sh",
    щ: "sch",
    ы: "y",
    э: "e",
    ю: "yu",
    я: "ya",
  };
  return (
    [...s.toLowerCase()]
      .map((c) => tr[c] ?? c)
      .join("")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "clip"
  );
}

/** Step 1 — import (§9.2): source files + required metadata (source and license are mandatory). */
export function NewClip() {
  const toast = useToast();
  const [files, setFiles] = useState<Partial<Record<SourceKind, File>>>({});
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [credit, setCredit] = useState("");
  const [license, setLicense] = useState("");
  const [customLicense, setCustomLicense] = useState("");
  const [rating, setRating] = useState<AgeRating>("12+");
  const [tags, setTags] = useState("");
  const [progress, setProgress] = useState<Partial<Record<SourceKind, number>>>({});
  const [busy, setBusy] = useState(false);

  const pick = (kind: SourceKind) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_BYTES) {
      toast({ text: "Файл больше 2 ГБ", kind: "error" });
      return;
    }
    setFiles((x) => ({ ...x, [kind]: f }));
    if (kind === "video" && !title) setTitle(f.name.replace(/\.[^.]+$/, ""));
  };

  const lic = license === "other" ? customLicense.trim() : license;
  const ready = files.video && title.trim() && credit.trim() && lic;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || !files.video) return;
    setBusy(true);
    try {
      // the browser may not decode the source (HEVC, MKV…) — then the worker's ffprobe measures it
      const probe = await probeDuration(files.video).catch(() => {
        toast(
          {
            text: "Браузер не может показать это видео — Studio сделает превью, это займёт минуту",
            kind: "info",
          },
          6000,
        );
        return { durationMs: 0, height: 0 };
      });
      if (probe.height && probe.height < 480)
        toast({ text: `Разрешение ${probe.height}p — нужно ≥ 480p`, kind: "error" });
      const manifest = emptyManifest({
        slug: slug || slugify(title),
        title: { ru: title.trim() },
        durationMs: probe.durationMs || 1000,
        credit: credit.trim(),
        license: lic,
        ageRating: rating,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 10),
        source: probe.durationMs
          ? { trimStartMs: 0, trimEndMs: probe.durationMs }
          : { trimStartMs: 0 },
      });
      const { draftId } = await api.createDraft(manifest);
      for (const kind of ["video", "bed", "dialogue"] as const) {
        const f = files[kind];
        if (!f) continue;
        setLocalFile(draftId, kind, f);
        await uploadSource(draftId, kind, f, (p) => setProgress((x) => ({ ...x, [kind]: p })));
      }
      location.hash = `#/draft/${draftId}`;
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="new-clip">
      <h1>Новый клип</h1>
      <form className="form-grid dr-card" onSubmit={submit}>
        <FileField
          label="Видео-исходник * (MP4/MOV/MKV, до 2 ГБ)"
          accept={VIDEO_TYPES}
          file={files.video}
          progress={progress.video}
          onChange={pick("video")}
        />
        <FileField
          label="Фон без голосов (M&E) — если есть"
          hint="Музыка и эффекты без диалогов. Нет отдельной дорожки? Отделите голос: dubroom-clip separate (Demucs), см. справку."
          accept={AUDIO_TYPES}
          file={files.bed}
          progress={progress.bed}
          onChange={pick("bed")}
        />
        <FileField
          label="Выделенный голос (для разметки и режима «до/после»)"
          accept={AUDIO_TYPES}
          file={files.dialogue}
          progress={progress.dialogue}
          onChange={pick("dialogue")}
        />
        <label className="dr-field">
          <span>Название *</span>
          <input
            className="dr-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
          />
        </label>
        <label className="dr-field">
          <span>Адрес (slug)</span>
          <input
            className="dr-input"
            value={slug}
            placeholder={slugify(title || "clip")}
            onChange={(e) => setSlug(slugify(e.target.value))}
          />
        </label>
        <label className="dr-field">
          <span>Источник * (автор, фильм, ссылка)</span>
          <input
            className="dr-input"
            value={credit}
            onChange={(e) => setCredit(e.target.value)}
            placeholder="Blender Foundation, «Big Buck Bunny», peach.blender.org"
          />
        </label>
        <label className="dr-field">
          <span>Лицензия *</span>
          <select className="dr-input" value={license} onChange={(e) => setLicense(e.target.value)}>
            <option value="">— выберите —</option>
            {KNOWN_LICENSES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
            <option value="other">Другая…</option>
          </select>
        </label>
        {license === "other" && (
          <input
            className="dr-input"
            aria-label="Другая лицензия"
            value={customLicense}
            onChange={(e) => setCustomLicense(e.target.value)}
          />
        )}
        <label className="dr-field">
          <span>Возрастной рейтинг</span>
          <select
            className="dr-input"
            value={rating}
            onChange={(e) => setRating(e.target.value as AgeRating)}
          >
            {AGE_RATINGS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className="dr-field">
          <span>Теги через запятую</span>
          <input
            className="dr-input"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="комедия, животные"
          />
        </label>
        <Button type="submit" variant="primary" disabled={!ready || busy}>
          {busy ? "Загрузка…" : "Загрузить и перейти к разметке"}
        </Button>
      </form>
    </main>
  );
}

function FileField({
  label,
  hint,
  accept,
  file,
  progress,
  onChange,
}: {
  label: string;
  hint?: string;
  accept: string;
  file?: File;
  progress?: number;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className="dr-field">
      <span>{label}</span>
      <input type="file" accept={accept} onChange={onChange} />
      {hint && <small className="dr-muted">{hint}</small>}
      {file && (
        <small>
          {file.name} · {(file.size / 1e6).toFixed(1)} МБ
          {progress !== undefined && ` · ${Math.round(progress * 100)}%`}
        </small>
      )}
      {progress !== undefined && <progress max={1} value={progress} />}
    </label>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ROLE_COLORS,
  linesFromSrt,
  parseSrt,
  validateManifest,
  type ClipLine,
  type ClipManifest,
} from "@dubroom/clip-format";
import { TakeRecorder, decode } from "@dubroom/audio";
import { AGE_RATINGS, type AgeRating } from "@dubroom/shared";
import { Button, useToast } from "@dubroom/ui";
import { ApiError, api, uploadSource, type Draft, type SourceKind } from "./api.ts";
import { audioCtx } from "./audio.ts";
import { localFiles, setLocalFile } from "./localFiles.ts";
import { Waveform } from "./Waveform.tsx";
import { SubtitleOverlay } from "./SubtitleOverlay.tsx";
import { IssueList } from "./IssueList.tsx";
import { StatusBadge } from "./Library.tsx";

type Step = "trim" | "voice" | "lines" | "check" | "export";
const STEPS: { id: Step; label: string }[] = [
  { id: "trim", label: "2 Обрезка" },
  { id: "voice", label: "3 Голос" },
  { id: "lines", label: "4 Реплики" },
  { id: "check", label: "5 Проверка" },
  { id: "export", label: "6 Экспорт" },
];
const FRAME_MS = 1000 / 30;

const fmt = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(3).padStart(6, "0")}`;
};

/** Clip Studio editor (§9.2 steps 2–6, §20.3 layout). */
export function Editor({ draftId }: { draftId: string }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [m, setM] = useState<ClipManifest | null>(null);
  const [step, setStep] = useState<Step>("lines");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [wave, setWave] = useState<AudioBuffer | null>(null);
  const [bedBuf, setBedBuf] = useState<AudioBuffer | null>(null);
  const [srcPos, setSrcPos] = useState(0); // source time, ms
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  const editable = draft?.status === "draft" || draft?.status === "failed";
  const trimStart = m?.source?.trimStartMs ?? 0;
  const trimEnd = m?.source?.trimEndMs ?? m?.durationMs ?? 0;
  const clipDuration = Math.max(0, trimEnd - trimStart);
  const clipPos = srcPos - trimStart;

  // load draft + media
  useEffect(() => {
    let alive = true;
    api.draft(draftId).then(async ({ draft: d }) => {
      if (!alive) return;
      setDraft(d);
      setM(d.manifest);
      if (d.status !== "draft" && d.status !== "failed") setStep("export");
      const local = localFiles.get(draftId) ?? {};
      const get = async (kind: SourceKind): Promise<Blob | null> =>
        local[kind] ??
        (d.files[kind]?.received === d.files[kind]?.size && d.files[kind]
          ? await api.sourceBlob(draftId, kind).catch(() => null)
          : null);
      const v = await get("video");
      if (!alive || !v) return;
      setVideoUrl(URL.createObjectURL(v));
      const voice = (await get("dialogue")) ?? v;
      decode(audioCtx(), voice)
        .then((b) => alive && setWave(b))
        .catch(() => {});
      const bed = await get("bed");
      if (bed)
        decode(audioCtx(), bed)
          .then((b) => alive && setBedBuf(b))
          .catch(() => {});
    });
    return () => {
      alive = false;
    };
  }, [draftId]);

  // autosave (debounced)
  useEffect(() => {
    if (!dirty || !m || !editable) return;
    const t = setTimeout(async () => {
      setSaving(true);
      try {
        const r = await api.saveManifest(draftId, m);
        setDraft(r.draft);
        setDirty(false);
      } catch (e) {
        toast({ text: `Не сохранено: ${(e as Error).message}`, kind: "error" });
      } finally {
        setSaving(false);
      }
    }, 800);
    return () => clearTimeout(t);
  }, [dirty, m, editable, draftId, toast]);

  const update = useCallback((fn: (m: ClipManifest) => ClipManifest) => {
    setM((prev) => (prev ? fn(structuredClone(prev)) : prev));
    setDirty(true);
  }, []);

  const seekClip = useCallback(
    (ms: number) => {
      const v = video.current;
      if (!v) return;
      v.currentTime = (trimStart + Math.max(0, Math.min(ms, clipDuration))) / 1000;
      setSrcPos(v.currentTime * 1000);
    },
    [trimStart, clipDuration],
  );

  // track playback position
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    let raf = 0;
    const loop = () => {
      setSrcPos(v.currentTime * 1000);
      if (!v.paused && v.currentTime * 1000 >= trimEnd) v.pause();
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [videoUrl, trimEnd]);

  const selectedLine = m?.lines.find((l) => l.id === selected) ?? null;

  const setLine = useCallback(
    (id: string, patch: Partial<ClipLine>) =>
      update((mm) => {
        mm.lines = mm.lines.map((l) => (l.id === id ? { ...l, ...patch } : l));
        return mm;
      }),
    [update],
  );

  const addLine = useCallback(() => {
    if (!m) return;
    const start = Math.round(Math.max(0, clipPos));
    const id = `l${Math.max(0, ...m.lines.map((l) => Number(l.id.slice(1)) || 0)) + 1}`;
    const role = selectedLine?.role ?? m.roles[0]?.id ?? "r1";
    update((mm) => {
      mm.lines.push({
        id,
        role,
        startMs: start,
        endMs: Math.min(clipDuration, start + 1500),
        text: { ru: "" },
      });
      mm.lines.sort((a, b) => a.startMs - b.startMs);
      return mm;
    });
    setSelected(id);
  }, [m, clipPos, clipDuration, selectedLine, update]);

  // hotkeys (§9.2): I/O — line bounds, Space — play, ←/→ — ±1 frame, N — new line, Delete
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const v = video.current;
      if (!v) return;
      const now = Math.round(v.currentTime * 1000 - trimStart);
      switch (e.key) {
        case " ":
          e.preventDefault();
          if (v.paused) void v.play();
          else v.pause();
          break;
        case "ArrowLeft":
        case "ArrowRight":
          e.preventDefault();
          v.pause();
          v.currentTime = Math.max(
            0,
            v.currentTime + ((e.key === "ArrowLeft" ? -1 : 1) * FRAME_MS) / 1000,
          );
          break;
        case "i":
        case "I":
        case "ш":
        case "Ш":
          if (step === "trim")
            update((mm) => ({
              ...mm,
              source: { ...mm.source, trimStartMs: Math.round(v.currentTime * 1000) },
            }));
          else if (selectedLine) setLine(selectedLine.id, { startMs: Math.max(0, now) });
          break;
        case "o":
        case "O":
        case "щ":
        case "Щ":
          if (step === "trim")
            update((mm) => ({
              ...mm,
              source: { ...mm.source, trimEndMs: Math.round(v.currentTime * 1000) },
            }));
          else if (selectedLine) setLine(selectedLine.id, { endMs: Math.max(0, now) });
          break;
        case "n":
        case "N":
        case "т":
        case "Т":
          if (step === "lines") addLine();
          break;
        case "Delete":
          if (selectedLine && step === "lines") {
            update((mm) => ({ ...mm, lines: mm.lines.filter((l) => l.id !== selectedLine.id) }));
            setSelected(null);
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, selectedLine, setLine, addLine, update, trimStart]);

  const check = useMemo(
    () => (m ? validateManifest({ ...m, durationMs: clipDuration }) : null),
    [m, clipDuration],
  );

  if (!draft || !m) return <main className="library">Загрузка…</main>;

  return (
    <div className="editor">
      <div className="editor__bar">
        <strong>
          Clip Studio · «{m.title.ru ?? m.slug}» · v{draft.version}
        </strong>
        <StatusBadge status={draft.status} />
        <span className="dr-muted small">
          {saving ? "сохранение…" : dirty ? "изменено" : "сохранено"}
        </span>
      </div>
      <aside className="editor__steps">
        <div className="step step--done">✓ 1 Импорт</div>
        {STEPS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`step ${step === s.id ? "step--active" : ""}`}
            onClick={() => setStep(s.id)}
          >
            {s.label}
          </button>
        ))}
        <p className="dr-muted small hotkeys">
          <kbd>Space</kbd> пуск/пауза
          <br />
          <kbd>I</kbd>/<kbd>O</kbd> начало/конец
          <br />
          <kbd>←</kbd>/<kbd>→</kbd> ±1 кадр
          <br />
          <kbd>N</kbd> новая реплика
          <br />
          <kbd>Del</kbd> удалить
        </p>
      </aside>

      <section className="editor__main">
        <div className="player">
          {videoUrl ? (
            <video ref={video} src={videoUrl} playsInline controls={step !== "check"} />
          ) : (
            <div className="dr-skeleton player__skeleton" />
          )}
          {step === "lines" && <SubtitleOverlay manifest={m} positionMs={clipPos} />}
        </div>
        <div className="row small">
          <span className="mono">
            {fmt(clipPos)} / {fmt(clipDuration)}
          </span>
          <Button size="small" onClick={() => seekClip(0)}>
            ⏮
          </Button>
        </div>
        {step !== "check" && step !== "export" && (
          <>
            <div className="track-label">Голос</div>
            <Waveform
              buffer={wave}
              offsetMs={trimStart}
              durationMs={clipDuration}
              lines={m.lines}
              roles={m.roles}
              selected={selected}
              positionMs={clipPos}
              onSeek={seekClip}
              onSelect={(id) => {
                setSelected(id);
                const l = m.lines.find((x) => x.id === id);
                if (l) seekClip(l.startMs);
              }}
            />
            {!bedBuf && (
              <p className="warn-text small">
                ⚠ Нет отдельного фона: в игре будет звучать исходный звук видео вместе с голосами
                (шаг 3).
              </p>
            )}
          </>
        )}
        {step === "check" && (
          <CheckStep
            manifest={m}
            clipDuration={clipDuration}
            trimStart={trimStart}
            video={video}
            bed={bedBuf}
          />
        )}
        {step === "export" && (
          <ExportStep draft={draft} onDraft={setDraft} check={check} dirty={dirty} />
        )}
      </section>

      <aside className="editor__props">
        <fieldset disabled={!editable} className="form-grid">
          {step === "trim" && (
            <TrimPanel m={m} update={update} current={Math.round(srcPos)} duration={m.durationMs} />
          )}
          {step === "voice" && (
            <VoicePanel
              draft={draft}
              onUploaded={(kind, buf) => (kind === "bed" ? setBedBuf(buf) : setWave(buf))}
            />
          )}
          {step === "lines" && (
            <LinesPanel
              m={m}
              update={update}
              selected={selectedLine}
              setSelected={setSelected}
              setLine={setLine}
              addLine={addLine}
            />
          )}
          {(step === "check" || step === "export") && <MetaPanel m={m} update={update} />}
        </fieldset>
        {check && step !== "trim" && (
          <div className="editor__check">
            <h3>Проверки</h3>
            <IssueList errors={check.errors} warnings={check.warnings} />
          </div>
        )}
      </aside>
    </div>
  );
}

type Update = (fn: (m: ClipManifest) => ClipManifest) => void;

function TrimPanel({
  m,
  update,
  current,
  duration,
}: {
  m: ClipManifest;
  update: Update;
  current: number;
  duration: number;
}) {
  const start = m.source?.trimStartMs ?? 0;
  const end = m.source?.trimEndMs ?? duration;
  const len = (end - start) / 1000;
  const set = (patch: { trimStartMs?: number; trimEndMs?: number }) =>
    update((mm) => {
      const next = { ...mm.source, ...patch };
      // lines keep their position in the source when the in-point moves
      if (patch.trimStartMs !== undefined) {
        const d = patch.trimStartMs - start;
        mm.lines = mm.lines.map((l) => ({
          ...l,
          startMs: Math.max(0, l.startMs - d),
          endMs: Math.max(0, l.endMs - d),
        }));
      }
      return { ...mm, source: next };
    });
  return (
    <>
      <h3>Обрезка</h3>
      <p className="dr-muted small">Рекомендуемая длина — 10–60 с (допустимо 5–90 с).</p>
      <div className="row">
        <Button size="small" onClick={() => set({ trimStartMs: Math.min(current, end - 1000) })}>
          [ Начало = кадр
        </Button>
        <Button size="small" onClick={() => set({ trimEndMs: Math.max(current, start + 1000) })}>
          Конец = кадр ]
        </Button>
      </div>
      <label className="dr-field">
        <span>Начало, мс</span>
        <input
          className="dr-input"
          type="number"
          min={0}
          value={start}
          onChange={(e) => set({ trimStartMs: Math.max(0, Number(e.target.value)) })}
        />
      </label>
      <label className="dr-field">
        <span>Конец, мс</span>
        <input
          className="dr-input"
          type="number"
          min={0}
          max={duration}
          value={end}
          onChange={(e) => set({ trimEndMs: Math.min(duration, Number(e.target.value)) })}
        />
      </label>
      <p
        className={
          len < 5 || len > 90 ? "error-text" : len < 10 || len > 60 ? "warn-text" : "ok-text"
        }
      >
        Длина: {len.toFixed(1)} с
      </p>
    </>
  );
}

function VoicePanel({
  draft,
  onUploaded,
}: {
  draft: Draft;
  onUploaded: (kind: SourceKind, buf: AudioBuffer) => void;
}) {
  const toast = useToast();
  const [progress, setProgress] = useState<Partial<Record<SourceKind, number>>>({});
  const upload = (kind: "bed" | "dialogue") => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      setLocalFile(draft.id, kind, f);
      await uploadSource(draft.id, kind, f, (p) => setProgress((x) => ({ ...x, [kind]: p })));
      onUploaded(kind, await decode(audioCtx(), f));
      toast({ text: "Загружено", kind: "success" }, 2000);
    } catch (err) {
      toast({ text: (err as Error).message, kind: "error" });
    }
  };
  const has = (k: SourceKind) =>
    draft.files[k] && draft.files[k]!.received === draft.files[k]!.size;
  return (
    <>
      <h3>Отделение голоса</h3>
      <p className="small">
        В игре фон (музыка + эффекты) звучит отдельно от голосов игроков. Лучший вариант — исходная
        M&amp;E-дорожка. Иначе отделите голос нейросетью Demucs:
      </p>
      <pre className="code small">dubroom-clip separate ./my-clip</pre>
      <p className="small dr-muted">
        и загрузите <code>bed.wav</code> (фон) и <code>dialogue.wav</code> (голос). «Призраки»
        голоса в фоне приглушите в Audacity — см. справку автора.
      </p>
      <label className="dr-field">
        <span>Фон (bed) {has("bed") ? "✓" : ""}</span>
        <input type="file" accept="audio/*,.wav,.flac" onChange={upload("bed")} />
        {progress.bed !== undefined && <progress max={1} value={progress.bed} />}
      </label>
      <label className="dr-field">
        <span>Голос (dialogue) {has("dialogue") ? "✓" : ""}</span>
        <input type="file" accept="audio/*,.wav,.flac" onChange={upload("dialogue")} />
        {progress.dialogue !== undefined && <progress max={1} value={progress.dialogue} />}
      </label>
    </>
  );
}

function LinesPanel({
  m,
  update,
  selected,
  setSelected,
  setLine,
  addLine,
}: {
  m: ClipManifest;
  update: Update;
  selected: ClipLine | null;
  setSelected: (id: string | null) => void;
  setLine: (id: string, patch: Partial<ClipLine>) => void;
  addLine: () => void;
}) {
  const importSrt = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const lines = linesFromSrt(parseSrt(await f.text()));
    update((mm) => {
      mm.lines = lines;
      for (const id of new Set(lines.map((l) => l.role))) {
        if (!mm.roles.some((r) => r.id === id)) {
          mm.roles.push({
            id: /^r\d+$/.test(id) ? id : `r${mm.roles.length + 1}`,
            name: { ru: id },
            color: ROLE_COLORS[mm.roles.length % 6]!,
          });
        }
      }
      return mm;
    });
  };
  return (
    <>
      <h3>Роли</h3>
      {m.roles.map((r, i) => (
        <div key={r.id} className="row">
          <input
            type="color"
            aria-label={`Цвет роли ${r.id}`}
            value={r.color}
            onChange={(e) =>
              update((mm) => ((mm.roles[i]!.color = e.target.value.toUpperCase()), mm))
            }
          />
          <input
            className="dr-input"
            aria-label={`Имя роли ${r.id}`}
            value={r.name.ru ?? ""}
            onChange={(e) => update((mm) => ((mm.roles[i]!.name.ru = e.target.value), mm))}
          />
          {m.roles.length > 1 && (
            <Button
              size="small"
              variant="ghost"
              aria-label={`Удалить роль ${r.id}`}
              onClick={() =>
                update((mm) => ({
                  ...mm,
                  roles: mm.roles.filter((x) => x.id !== r.id),
                  lines: mm.lines.filter((l) => l.role !== r.id),
                }))
              }
            >
              ✕
            </Button>
          )}
        </div>
      ))}
      {m.roles.length < 6 && (
        <Button
          size="small"
          onClick={() =>
            update((mm) => {
              const n = Math.max(0, ...mm.roles.map((r) => Number(r.id.slice(1)) || 0)) + 1;
              mm.roles.push({
                id: `r${n}`,
                name: { ru: `Роль ${n}` },
                color: ROLE_COLORS[(n - 1) % 6]!,
              });
              return mm;
            })
          }
        >
          + Роль
        </Button>
      )}

      <h3>Реплики ({m.lines.length})</h3>
      <div className="row">
        <Button size="small" onClick={addLine}>
          + Реплика (N)
        </Button>
        <label className="dr-btn dr-btn--small dr-btn--ghost">
          Импорт SRT
          <input type="file" accept=".srt" hidden onChange={importSrt} />
        </label>
      </div>
      <ol className="line-list">
        {m.lines.map((l) => (
          <li key={l.id}>
            <button
              type="button"
              className={`line-item ${selected?.id === l.id ? "line-item--sel" : ""}`}
              onClick={() => setSelected(l.id)}
            >
              <span
                className="dot"
                style={{ background: m.roles.find((r) => r.id === l.role)?.color }}
              />
              {fmt(l.startMs)} {l.text.ru || "…"}
            </button>
          </li>
        ))}
      </ol>

      {selected && (
        <div className="line-props">
          <h3>Свойства реплики {selected.id}</h3>
          <label className="dr-field">
            <span>Роль</span>
            <select
              className="dr-input"
              value={selected.role}
              onChange={(e) => setLine(selected.id, { role: e.target.value })}
            >
              {m.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name.ru ?? r.id}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <label className="dr-field">
              <span>Начало, мс (I)</span>
              <input
                className="dr-input"
                type="number"
                value={selected.startMs}
                onChange={(e) => setLine(selected.id, { startMs: Number(e.target.value) })}
              />
            </label>
            <label className="dr-field">
              <span>Конец, мс (O)</span>
              <input
                className="dr-input"
                type="number"
                value={selected.endMs}
                onChange={(e) => setLine(selected.id, { endMs: Number(e.target.value) })}
              />
            </label>
          </div>
          <label className="dr-field">
            <span>Текст (RU)</span>
            <textarea
              className="dr-input"
              rows={2}
              value={selected.text.ru ?? ""}
              onChange={(e) =>
                setLine(selected.id, { text: { ...selected.text, ru: e.target.value } })
              }
            />
          </label>
          <label className="dr-field">
            <span>Текст (EN)</span>
            <textarea
              className="dr-input"
              rows={2}
              value={selected.text.en ?? ""}
              onChange={(e) =>
                setLine(selected.id, {
                  text: { ...selected.text, en: e.target.value || undefined },
                })
              }
            />
          </label>
          <label className="dr-field">
            <span>Подсказка интонации</span>
            <input
              className="dr-input"
              value={selected.hint ?? ""}
              maxLength={60}
              onChange={(e) => setLine(selected.id, { hint: e.target.value || undefined })}
            />
          </label>
        </div>
      )}
    </>
  );
}

function MetaPanel({ m, update }: { m: ClipManifest; update: Update }) {
  return (
    <>
      <h3>Описание</h3>
      <label className="dr-field">
        <span>Название (RU)</span>
        <input
          className="dr-input"
          value={m.title.ru ?? ""}
          onChange={(e) => update((mm) => ({ ...mm, title: { ...mm.title, ru: e.target.value } }))}
        />
      </label>
      <label className="dr-field">
        <span>Название (EN)</span>
        <input
          className="dr-input"
          value={m.title.en ?? ""}
          onChange={(e) =>
            update((mm) => ({ ...mm, title: { ...mm.title, en: e.target.value || undefined } }))
          }
        />
      </label>
      <label className="dr-field">
        <span>Рейтинг</span>
        <select
          className="dr-input"
          value={m.ageRating}
          onChange={(e) => update((mm) => ({ ...mm, ageRating: e.target.value as AgeRating }))}
        >
          {AGE_RATINGS.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <label className="dr-field">
        <span>Источник</span>
        <input
          className="dr-input"
          value={m.credit}
          onChange={(e) => update((mm) => ({ ...mm, credit: e.target.value }))}
        />
      </label>
      <label className="dr-field">
        <span>Лицензия</span>
        <input
          className="dr-input"
          value={m.license}
          onChange={(e) => update((mm) => ({ ...mm, license: e.target.value }))}
        />
      </label>
    </>
  );
}

/** Step 5 — preview modes (§9.2): as a player, original, and a test take by the author. */
function CheckStep({
  manifest,
  clipDuration,
  trimStart,
  video,
  bed,
}: {
  manifest: ClipManifest;
  clipDuration: number;
  trimStart: number;
  video: React.RefObject<HTMLVideoElement | null>;
  bed: AudioBuffer | null;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [take, setTake] = useState<AudioBuffer | null>(null);

  const run = async (mode: "player" | "original" | "record" | "take") => {
    const v = video.current;
    if (!v) return;
    const ctx = audioCtx();
    await ctx.resume();
    setBusy(mode);
    const nodes: AudioBufferSourceNode[] = [];
    const startIn = 0.1;
    const at = ctx.currentTime + startIn;
    const play = (buf: AudioBuffer, offsetS = 0) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.connect(ctx.destination);
      s.start(at, offsetS);
      nodes.push(s);
    };
    let rec: TakeRecorder | null = null;
    try {
      v.pause();
      v.currentTime = trimStart / 1000;
      v.muted = mode !== "original";
      if (mode !== "original" && bed) play(bed, trimStart / 1000);
      if (mode === "take" && take) play(take);
      if (mode === "record") {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false },
        });
        rec = new TakeRecorder(stream);
        await rec.start();
      }
      await new Promise((r) => setTimeout(r, startIn * 1000));
      await v.play();
      await new Promise((r) => setTimeout(r, clipDuration + 300));
      v.pause();
      if (rec) {
        const t = await rec.stop();
        setTake(await decode(ctx, t.blob));
        toast({ text: "Тестовая запись готова — нажмите «Прослушать дубль»", kind: "success" });
      }
    } catch (e) {
      toast({ text: (e as Error).message, kind: "error" });
    } finally {
      nodes.forEach((n) => n.stop());
      v.muted = false;
      setBusy(null);
    }
  };

  return (
    <div className="check-step">
      <div className="row">
        <Button onClick={() => void run("player")} disabled={!!busy}>
          ▶ Как у игрока (без голоса)
        </Button>
        <Button onClick={() => void run("original")} disabled={!!busy}>
          ▶ Оригинал
        </Button>
        <Button onClick={() => void run("record")} disabled={!!busy}>
          ● Тестовая запись
        </Button>
        <Button onClick={() => void run("take")} disabled={!!busy || !take}>
          ▶ Прослушать дубль
        </Button>
      </div>
      <p className="dr-muted small">
        Чек-лист автора: права указаны · голос в фоне не слышен · реплики размечены · тестовая
        запись совпала с губами · рейтинг выставлен.
      </p>
      <p className="dr-muted small">
        Реплик: {manifest.lines.length}, ролей: {manifest.roles.length}
      </p>
    </div>
  );
}

/** Step 6 — submit to the media worker and follow its progress. */
function ExportStep({
  draft,
  onDraft,
  check,
  dirty,
}: {
  draft: Draft;
  onDraft: (d: Draft) => void;
  check: ReturnType<typeof validateManifest> | null;
  dirty: boolean;
}) {
  const toast = useToast();
  const processing = draft.status === "queued" || draft.status === "processing";

  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => api.draft(draft.id).then((r) => onDraft(r.draft)), 2000);
    return () => clearInterval(t);
  }, [processing, draft.id, onDraft]);

  const submit = async () => {
    try {
      const r = await api.submit(draft.id);
      onDraft(r.draft);
    } catch (e) {
      const issues = e instanceof ApiError ? e.body.issues : undefined;
      toast({ text: issues?.[0]?.message ?? (e as Error).message, kind: "error" });
    }
  };

  return (
    <div className="export">
      <h3>Экспорт</h3>
      {(draft.status === "draft" || draft.status === "failed") && (
        <>
          <p className="small">
            Пакет уйдёт в обработку: видео в 720/480/360p, фон с нормализацией громкости, постер,
            превью, субтитры. Затем клип попадёт на модерацию.
          </p>
          <Button variant="primary" onClick={submit} disabled={!check?.ok || dirty}>
            Отправить на обработку
          </Button>
          {dirty && <p className="dr-muted small">Сохраняем изменения…</p>}
        </>
      )}
      {processing && (
        <p>
          <StatusBadge status={draft.status} /> {Math.round(draft.progress * 100)}%{" "}
          <progress max={1} value={draft.progress} />
        </p>
      )}
      {draft.status === "done" && (
        <p className="ok-text">
          ✓ Готово. Версия v{draft.version} ждёт модерации в <a href="#/">библиотеке</a>.
        </p>
      )}
      <IssueList errors={draft.errors} warnings={draft.warnings} />
    </div>
  );
}

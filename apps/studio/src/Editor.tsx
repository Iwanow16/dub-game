import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ROLE_COLORS,
  SCENE_LIMITS,
  autoScenes,
  linesFromSrt,
  parseSrt,
  validateManifest,
  type ClipLine,
  type ClipManifest,
  type ClipScene,
} from "@dubroom/clip-format";
import { TakeRecorder, decode } from "@dubroom/audio";
import { AGE_RATINGS, type AgeRating } from "@dubroom/shared";
import { Button, useToast } from "@dubroom/ui";
import { ApiError, api, uploadSource, type Draft, type SourceKind } from "./api.ts";
import { audioCtx, fetchPeaks, peaksFromBuffer, type Peaks } from "./audio.ts";
import { canPlay, localFiles, setLocalFile } from "./localFiles.ts";
import { Waveform, type View } from "./Waveform.tsx";
import { SubtitleOverlay } from "./SubtitleOverlay.tsx";
import { IssueList } from "./IssueList.tsx";
import { StatusBadge } from "./Library.tsx";

type Step = "trim" | "voice" | "lines" | "scenes" | "check" | "export";
const STEPS: { id: Step; label: string }[] = [
  { id: "trim", label: "2 Обрезка" },
  { id: "voice", label: "3 Голос" },
  { id: "lines", label: "4 Реплики" },
  { id: "scenes", label: "5 Сцены" },
  { id: "check", label: "6 Проверка" },
  { id: "export", label: "7 Экспорт" },
];
const FRAME_MS = 1000 / 30;
/** sources above this are not downloaded whole: the proxy streams by a signed link (ADR-0009) */
const LARGE_BYTES = 200 * 1024 * 1024;
const LARGE_MS = 10 * 60_000;
/** decoding a whole file into an AudioBuffer is fine only for short media */
const DECODE_MAX_MS = 10 * 60_000;
const ZOOMS = [1, 2, 4, 8, 16, 32, 64];

const fmt = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = (s % 60).toFixed(3).padStart(6, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/** Clip Studio editor (§9.2 steps 2–6, §20.3 layout). */
export function Editor({ draftId }: { draftId: string }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [m, setM] = useState<ClipManifest | null>(null);
  const [step, setStep] = useState<Step>("lines");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [wave, setWave] = useState<Peaks | null>(null);
  const [zoom, setZoom] = useState(1);
  const [viewStart, setViewStart] = useState(0);
  const [selectedScene, setSelectedScene] = useState<string | null>(null);
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
  const span = clipDuration > 0 ? clipDuration / zoom : 1;
  const view: View = {
    start: Math.max(0, Math.min(viewStart, clipDuration - span)),
    span,
  };

  const [media, setMedia] = useState<"loading" | "ready" | "proxy-wait" | "failed">("loading");

  // load the draft
  useEffect(() => {
    let alive = true;
    api.draft(draftId).then(({ draft: d }) => {
      if (!alive) return;
      setDraft(d);
      setM(d.manifest);
      if (d.status !== "draft" && d.status !== "failed") setStep("export");
    });
    return () => {
      alive = false;
    };
  }, [draftId]);

  // media: the author's own file if the browser can decode it, otherwise the worker's proxy
  const proxyStatus = draft?.proxyStatus;
  useEffect(() => {
    if (!draft || media === "ready") return;
    let alive = true;
    (async () => {
      const local = localFiles.get(draftId) ?? {};
      const complete = (k: SourceKind) =>
        draft.files[k] && draft.files[k]!.received === draft.files[k]!.size;
      const get = async (k: SourceKind | "proxy"): Promise<Blob | null> =>
        (k !== "proxy" ? local[k] : undefined) ??
        (k === "proxy" || complete(k) ? await api.sourceBlob(draftId, k).catch(() => null) : null);

      const large =
        (draft.files.video?.size ?? 0) > LARGE_BYTES || (draft.sourceDurationMs ?? 0) > LARGE_MS;
      const toWave = (b: AudioBuffer) => alive && setWave(peaksFromBuffer(b));

      let videoBlob: Blob | null = large ? null : (local.video ?? null);
      if (videoBlob) {
        const url = URL.createObjectURL(videoBlob);
        if (!(await canPlay(url))) {
          URL.revokeObjectURL(url);
          videoBlob = null;
        } else if (alive) setVideoUrl(url);
      }
      if (!videoBlob) {
        if (proxyStatus === "queued" || proxyStatus === "processing")
          return alive && setMedia("proxy-wait");
        if (proxyStatus !== "done") return alive && setMedia("failed");
        if (large) {
          // long source: stream the proxy (Range requests) and draw the worker's peaks.bin
          const link = await api.mediaLink(draftId).catch(() => null);
          if (!link || !alive) return alive && setMedia("failed");
          setVideoUrl(link.proxy);
          setMedia("ready");
          const dialogue = local.dialogue;
          if (dialogue && dialogue.size < LARGE_BYTES)
            decode(audioCtx(), dialogue)
              .then(toWave)
              .catch(() => {});
          else fetchPeaks(link.peaks).then((p) => alive && p && setWave(p));
          const bed = local.bed;
          if (bed && (draft.sourceDurationMs ?? 0) <= DECODE_MAX_MS)
            decode(audioCtx(), bed)
              .then((b) => alive && setBedBuf(b))
              .catch(() => {});
          return;
        }
        videoBlob = await get("proxy");
        if (!videoBlob || !alive) return alive && setMedia("failed");
        setVideoUrl(URL.createObjectURL(videoBlob));
      }
      setMedia("ready");
      const voice = (await get("dialogue")) ?? videoBlob;
      decode(audioCtx(), voice)
        .then(toWave)
        .catch(async () => {
          // the source's audio may be undecodable too — the proxy's Opus always works
          const p = proxyStatus === "done" ? await get("proxy") : null;
          if (p)
            decode(audioCtx(), p)
              .then(toWave)
              .catch(() => {});
        });
      const bed = await get("bed");
      if (bed)
        decode(audioCtx(), bed)
          .then((b) => alive && setBedBuf(b))
          .catch(() => {});
    })();
    return () => {
      alive = false;
    };
    // re-run when the proxy becomes available
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, proxyStatus, Boolean(draft)]);

  // poll while the proxy is being made; adopt the exact source duration measured by ffprobe
  useEffect(() => {
    if (proxyStatus !== "queued" && proxyStatus !== "processing") return;
    const t = setInterval(() => api.draft(draftId).then((r) => setDraft(r.draft)), 2000);
    return () => clearInterval(t);
  }, [proxyStatus, draftId]);

  const measured = draft?.sourceDurationMs ?? null;
  useEffect(() => {
    if (!measured || !m || m.durationMs === measured) return;
    update((mm) => ({
      ...mm,
      durationMs: measured,
      source: {
        ...mm.source,
        trimStartMs: Math.min(mm.source?.trimStartMs ?? 0, measured - 1000),
        trimEndMs: Math.min(
          mm.source?.trimEndMs && mm.source.trimEndMs > 1000 ? mm.source.trimEndMs : measured,
          measured,
        ),
      },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measured]);

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

  // the zoomed timeline follows the playhead
  useEffect(() => {
    if (zoom === 1) return;
    if (clipPos < view.start || clipPos > view.start + view.span)
      setViewStart(Math.max(0, clipPos - view.span * 0.1));
  }, [clipPos, zoom, view.start, view.span]);

  const selectedLine = m?.lines.find((l) => l.id === selected) ?? null;
  const scenes = useMemo(
    () => [...(m?.scenes ?? [])].sort((a, b) => a.startMs - b.startMs),
    [m?.scenes],
  );
  const sceneAtPos = scenes.find((sc) => clipPos >= sc.startMs && clipPos < sc.endMs) ?? null;

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

  /** Splits the scene under `at` (or starts scenes at `at`), keeping lines whole. */
  const splitScene = useCallback(
    (at: number) =>
      update((mm) => {
        const list = [...(mm.scenes ?? [])].sort((a, b) => a.startMs - b.startMs);
        // never cut a line: move the cut to the end of a line under it
        const cutting = mm.lines.find((l) => l.startMs < at && l.endMs > at);
        const cut = Math.round(cutting ? cutting.endMs : at);
        if (!list.length) list.push({ id: "s1", startMs: 0, endMs: clipDuration });
        const sc = list.find((x) => cut > x.startMs && cut < x.endMs);
        if (!sc) return mm;
        const next = nextSceneId(list);
        list.push({ id: next, startMs: cut, endMs: sc.endMs });
        sc.endMs = cut;
        mm.scenes = list.sort((a, b) => a.startMs - b.startMs);
        return mm;
      }),
    [update, clipDuration],
  );

  /** Removes the boundary nearest to `at`, merging the two scenes around it. */
  const mergeSceneAt = useCallback(
    (at: number) =>
      update((mm) => {
        const list = [...(mm.scenes ?? [])].sort((a, b) => a.startMs - b.startMs);
        if (list.length < 2) return mm;
        let best = 1;
        for (let i = 1; i < list.length; i++)
          if (Math.abs(list[i]!.startMs - at) < Math.abs(list[best]!.startMs - at)) best = i;
        list[best - 1]!.endMs = list[best]!.endMs;
        list.splice(best, 1);
        mm.scenes = list;
        return mm;
      }),
    [update],
  );

  // hotkeys (§9.2): I/O — line bounds, Space — play, ←/→ — ±1 frame, N — new line, Delete
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.key === "n" || e.key === "N" || e.key === "т" || e.key === "Т") && step === "lines") {
        addLine();
        return;
      }
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
        case "[":
        case "х":
          if (step === "scenes") splitScene(Math.max(0, now));
          break;
        case "]":
        case "ъ":
          if (step === "scenes") mergeSceneAt(Math.max(0, now));
          break;
        case "+":
        case "=":
          setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)]!);
          break;
        case "-":
          setZoom((z) => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)]!);
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
  }, [step, selectedLine, setLine, addLine, update, trimStart, splitScene, mergeSceneAt]);

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
          <br />
          <kbd>[</kbd>/<kbd>]</kbd> разрезать/склеить сцену
          <br />
          <kbd>+</kbd>/<kbd>−</kbd> масштаб
        </p>
      </aside>

      <section className="editor__main">
        <div className="player">
          {media === "proxy-wait" && (
            <div className="player__msg">Готовим превью для браузера…</div>
          )}
          {media === "failed" && (
            <div className="player__msg error-text">
              Не удалось показать видео: {draft.errors[0]?.message ?? "формат не поддерживается"}
            </div>
          )}
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
            <div className="zoom row small">
              <span>Масштаб</span>
              <Button
                size="small"
                aria-label="Уменьшить масштаб"
                disabled={zoom === ZOOMS[0]}
                onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)]!)}
              >
                −
              </Button>
              <span className="mono">×{zoom}</span>
              <Button
                size="small"
                aria-label="Увеличить масштаб"
                disabled={zoom === ZOOMS[ZOOMS.length - 1]}
                onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)]!)}
              >
                +
              </Button>
              {zoom > 1 && (
                <input
                  type="range"
                  aria-label="Прокрутка таймлайна"
                  min={0}
                  max={Math.max(0, clipDuration - view.span)}
                  step={100}
                  value={view.start}
                  onChange={(e) => setViewStart(Number(e.target.value))}
                />
              )}
            </div>
            <Waveform
              peaks={wave}
              offsetMs={trimStart}
              durationMs={clipDuration}
              view={view}
              lines={m.lines}
              roles={m.roles}
              scenes={step === "scenes" || scenes.length > 1 ? scenes : []}
              selected={selected}
              selectedScene={selectedScene}
              positionMs={clipPos}
              onSeek={seekClip}
              onSelect={(id) => {
                setSelected(id);
                const l = m.lines.find((x) => x.id === id);
                if (l) seekClip(l.startMs);
              }}
              onSelectScene={(id) => {
                setSelectedScene(id);
                const sc = scenes.find((x) => x.id === id);
                if (sc) seekClip(sc.startMs);
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
              onUploaded={(kind, buf) =>
                kind === "bed" ? setBedBuf(buf) : setWave(peaksFromBuffer(buf))
              }
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
          {step === "scenes" && (
            <ScenesPanel
              m={m}
              update={update}
              scenes={scenes}
              clipDuration={clipDuration}
              selected={selectedScene ?? sceneAtPos?.id ?? null}
              onSelect={(id) => {
                setSelectedScene(id);
                const sc = scenes.find((x) => x.id === id);
                if (sc) seekClip(sc.startMs);
              }}
              split={() => splitScene(Math.max(0, Math.round(clipPos)))}
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
        if (mm.scenes?.length) {
          mm.scenes = mm.scenes.map((sc) => ({
            ...sc,
            startMs: Math.max(0, sc.startMs - d),
            endMs: Math.max(0, sc.endMs - d),
          }));
          mm.scenes[0]!.startMs = 0;
        }
      }
      return { ...mm, source: next };
    });
  return (
    <>
      <h3>Обрезка</h3>
      <p className="dr-muted small">
        Длина не ограничена: короткий клип (10–60 с) играется целиком, длинный — трейлер, фрагмент
        серии — делится на сцены (шаг 5), а в режиме «целиком» проигрывается потоково.
      </p>
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
      <p className={len < 5 ? "error-text" : "ok-text"}>
        Длина: {fmt(len * 1000)}
        {len * 1000 > SCENE_LIMITS.autoAboveMs && " — длинный клип, разметьте сцены"}
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

function nextSceneId(list: { id: string }[]) {
  return `s${Math.max(0, ...list.map((x) => Number(x.id.slice(1)) || 0)) + 1}`;
}

/** Step 5 — scenes (ADR-0009): how a long clip is split into rounds. */
function ScenesPanel({
  m,
  update,
  scenes,
  clipDuration,
  selected,
  onSelect,
  split,
}: {
  m: ClipManifest;
  update: Update;
  scenes: ClipScene[];
  clipDuration: number;
  selected: string | null;
  onSelect: (id: string) => void;
  split: () => void;
}) {
  const sel = scenes.find((x) => x.id === selected) ?? null;
  const long = clipDuration > SCENE_LIMITS.autoAboveMs;
  const setScene = (id: string, patch: Partial<ClipScene>) =>
    update((mm) => {
      mm.scenes = (mm.scenes ?? []).map((x) => (x.id === id ? { ...x, ...patch } : x));
      return mm;
    });
  const lineCount = (sc: ClipScene) =>
    m.lines.filter((l) => l.startMs >= sc.startMs && l.endMs <= sc.endMs).length;
  return (
    <>
      <h3>Сцены</h3>
      <p className="small dr-muted">
        {long
          ? "Длинный клип играется по одной сцене за раунд. Сцена — 5 с…2 мин, реплика не может пересекать её границу."
          : "Короткий клип играется целиком; сцены нужны, только если хотите играть его частями."}
      </p>
      <div className="row">
        <Button
          size="small"
          onClick={() => update((mm) => ({ ...mm, scenes: autoScenes(mm.lines, clipDuration) }))}
        >
          Авторазбивка
        </Button>
        <Button size="small" onClick={split}>
          Разрезать здесь [
        </Button>
        {scenes.length > 0 && (
          <Button
            size="small"
            variant="ghost"
            onClick={() => update((mm) => ({ ...mm, scenes: undefined }))}
          >
            Сбросить
          </Button>
        )}
      </div>
      <ol className="scene-list">
        {scenes.map((sc) => {
          const len = sc.endMs - sc.startMs;
          const bad = len < SCENE_LIMITS.minMs || len > SCENE_LIMITS.maxMs;
          return (
            <li key={sc.id}>
              <button
                type="button"
                className={`line-item ${selected === sc.id ? "line-item--sel" : ""}`}
                onClick={() => onSelect(sc.id)}
              >
                <strong>{sc.id}</strong> {fmt(sc.startMs)} · {Math.round(len / 1000)} с ·{" "}
                {lineCount(sc)} репл.
                {bad && <span className="error-text"> ⚠</span>}
                {sc.title?.ru ? ` · ${sc.title.ru}` : ""}
              </button>
            </li>
          );
        })}
      </ol>
      {sel && (
        <div className="line-props">
          <h3>Сцена {sel.id}</h3>
          <label className="dr-field">
            <span>Название (RU)</span>
            <input
              className="dr-input"
              value={sel.title?.ru ?? ""}
              maxLength={60}
              onChange={(e) =>
                setScene(sel.id, {
                  title: e.target.value ? { ...sel.title, ru: e.target.value } : undefined,
                })
              }
            />
          </label>
          <div className="row">
            <label className="dr-field">
              <span>Начало, мс</span>
              <input
                className="dr-input"
                type="number"
                value={sel.startMs}
                onChange={(e) => setScene(sel.id, { startMs: Number(e.target.value) })}
              />
            </label>
            <label className="dr-field">
              <span>Конец, мс</span>
              <input
                className="dr-input"
                type="number"
                value={sel.endMs}
                onChange={(e) => setScene(sel.id, { endMs: Number(e.target.value) })}
              />
            </label>
          </div>
          <Button
            size="small"
            variant="danger"
            onClick={() =>
              update((mm) => {
                const list = [...(mm.scenes ?? [])].sort((a, b) => a.startMs - b.startMs);
                const i = list.findIndex((x) => x.id === sel.id);
                // the neighbour absorbs the removed range
                if (i > 0) list[i - 1]!.endMs = list[i]!.endMs;
                else if (list[1]) list[1].startMs = list[0]!.startMs;
                list.splice(i, 1);
                mm.scenes = list.length ? list : undefined;
                return mm;
              })
            }
          >
            Удалить сцену
          </Button>
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

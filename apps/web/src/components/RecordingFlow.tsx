import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EFFECT_LABELS,
  LevelMeter as Meter,
  TakeRecorder,
  activeRms,
  alignOffsetMs,
  decode,
} from "@dubroom/audio";
import {
  EFFECTS,
  localized,
  maxAttempts,
  normalizeGain,
  recordingBitrate,
  rehearsalAllowed,
  type EffectId,
} from "@dubroom/shared";
import { Button, LevelMeter, LineTimeline, SyncSlider } from "@dubroom/ui";
import { audioContext, ctxTimeToPerf, roundTripMs, sounds, unlockAudio } from "../lib/audio.ts";
import { loadClip, type ClipRef, type LoadedClip } from "../lib/media.ts";
import { useMic } from "../lib/mic.ts";
import { usePrefs } from "../lib/prefs.ts";
import { playOnStage, type Playback } from "../lib/stage.ts";
import { useLang, useT } from "../lib/i18n.ts";
import { Countdown, Stage } from "./Stage.tsx";
import { MicHelp } from "./MicHelp.tsx";

export interface FinishedTake {
  blob: Blob;
  offsetMs: number;
  effect: EffectId;
  gain: number;
}

type Mode = "loading" | "menu" | "rehearsing" | "countdown" | "recording" | "review";

const COUNTDOWN_S = 3;
const TAIL_MS = 600;

/**
 * Rehearse → countdown → record → listen back with effect + sync slider → submit (US-3, §20.3).
 * Used by the record phase and by solo practice.
 */
export function RecordingFlow({
  clipEntry,
  myRoles,
  improv,
  onLoaded,
  onRecordingChange,
  onSubmit,
  submitLabel,
  busy,
}: {
  clipEntry: ClipRef;
  myRoles: string[] | null;
  improv?: boolean;
  onLoaded?: () => void;
  onRecordingChange?: (recording: boolean) => void;
  onSubmit: (take: FinishedTake) => void;
  submitLabel?: string;
  busy?: boolean;
}) {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const prefs = usePrefs();
  const mic = useMic();
  const videoRef = useRef<HTMLVideoElement>(null);
  const playback = useRef<Playback | null>(null);
  const recorder = useRef<TakeRecorder | null>(null);
  const [clip, setClip] = useState<LoadedClip | null>(null);
  const [loadPct, setLoadPct] = useState(0);
  const [mode, setMode] = useState<Mode>("loading");
  const [pos, setPos] = useState(-1);
  const [count, setCount] = useState(0);
  const [attempts, setAttempts] = useState(0);
  const [level, setLevel] = useState(0);
  const [silentHint, setSilentHint] = useState(false);
  const [take, setTake] = useState<{
    blob: Blob;
    /** decoded take (short clips/scenes) or a blob URL played as a stream (long clips) */
    buffer: AudioBuffer | null;
    url: string | null;
    baseOffset: number;
    gain: number;
  } | null>(null);
  /** loudness of the voice measured live while recording (long takes aren't decoded) */
  const liveRms = useRef({ sum: 0, n: 0 });
  const [effect, setEffect] = useState<EffectId>("none");
  const [manual, setManual] = useState(0);
  const [loadError, setLoadError] = useState(false);

  // load the clip fully before anything else (§11.3 step 4)
  useEffect(() => {
    let alive = true;
    void mic.open();
    loadClip(clipEntry, (p) => alive && setLoadPct(p))
      .then((c) => {
        if (!alive) return;
        setClip(c);
        setMode("menu");
        onLoaded?.();
      })
      .catch(() => alive && setLoadError(true));
    return () => {
      alive = false;
      playback.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipEntry.manifestUrl, clipEntry.scene?.id]);

  // live mic level + "we can't hear you" hint during own lines (§20.3)
  useEffect(() => {
    if (!mic.stream) return;
    const meter = new Meter(audioContext(), mic.stream);
    let raf = 0;
    let silentSince = 0;
    const loop = () => {
      const l = meter.level();
      setLevel(l);
      raf = requestAnimationFrame(loop);
      if (mode === "recording" && l > 0.05) {
        // level() is RMS × 5, clamped — collect the speaking parts for loudness matching
        liveRms.current.sum += (l / 5) ** 2;
        liveRms.current.n++;
      }
      if (mode !== "recording" || !clip) {
        silentSince = 0;
        return;
      }
      const p = posRef.current;
      const speaking = clip.manifest.lines.some(
        (ln) => (!myRoles || myRoles.includes(ln.role)) && p >= ln.startMs && p <= ln.endMs,
      );
      if (speaking && l < 0.04) {
        silentSince ||= performance.now();
        if (performance.now() - silentSince > 5000) setSilentHint(true);
      } else if (l >= 0.04) {
        silentSince = 0;
        setSilentHint(false);
      }
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      meter.dispose();
    };
  }, [mic.stream, mode, clip, myRoles]);

  const posRef = useRef(-1);
  const onPosition = useCallback((ms: number) => {
    posRef.current = ms;
    setPos(ms);
  }, []);

  const bedGain = prefs.headphones ? 1 : 0.35;
  const attemptsAllowed = clip ? maxAttempts(clip.manifest.durationMs) : 2;

  const rehearse = async () => {
    if (!clip || !videoRef.current) return;
    await unlockAudio();
    setMode("rehearsing");
    playback.current = await playOnStage(videoRef.current, { clip, bedGain, onPosition });
    await playback.current.done;
    setMode("menu");
    setPos(-1);
  };

  const record = async () => {
    if (!clip || !videoRef.current || !mic.stream) return;
    await unlockAudio();
    playback.current?.stop();
    setTake(null);
    setSilentHint(false);
    setMode("countdown");
    const rec = new TakeRecorder(mic.stream, recordingBitrate(clip.manifest.durationMs));
    recorder.current = rec;
    liveRms.current = { sum: 0, n: 0 };
    const recStart = await rec.start();
    const ctx = audioContext();
    const when = ctx.currentTime + COUNTDOWN_S;
    for (let i = COUNTDOWN_S; i > 0; i--) {
      setTimeout(
        () => {
          setCount(i);
          sounds.countdown();
        },
        (COUNTDOWN_S - i) * 1000,
      );
    }
    setTimeout(() => {
      setMode("recording");
      onRecordingChange?.(true);
      sounds.recStart();
    }, COUNTDOWN_S * 1000);
    playback.current = await playOnStage(videoRef.current, {
      clip,
      when,
      bedGain,
      tailMs: TAIL_MS,
      onPosition,
    });
    // streamed clips may start a little later than asked (buffering): align to the real start
    const clipStartPerf = ctxTimeToPerf(ctx, playback.current.when);
    await playback.current.done;
    if (recorder.current !== rec) return; // restarted meanwhile
    const result = await rec.stop();
    recorder.current = null;
    onRecordingChange?.(false);
    setAttempts((a) => a + 1);
    const buffer = clip.streaming ? null : await decode(audioContext(), result.blob);
    const baseOffset = alignOffsetMs({
      recStartMs: recStart,
      clipStartMs: clipStartPerf,
      roundTripLatencyMs: roundTripMs(),
      manualOffsetMs: 0,
    });
    const rms = buffer
      ? activeRms(buffer.getChannelData(0), buffer.sampleRate)
      : Math.sqrt(liveRms.current.sum / Math.max(1, liveRms.current.n));
    const gain = normalizeGain(rms);
    setTake({
      blob: result.blob,
      buffer,
      url: buffer ? null : URL.createObjectURL(result.blob),
      baseOffset,
      gain,
    });
    setPos(-1);
    setMode("review");
  };

  const stopEarly = () => playback.current?.stop();

  const restart = async () => {
    const rec = recorder.current;
    recorder.current = null;
    playback.current?.stop();
    if (rec?.recording) await rec.stop().catch(() => {});
    onRecordingChange?.(false);
    void record();
  };

  const listen = async () => {
    if (!clip || !take || !videoRef.current) return;
    await unlockAudio();
    playback.current?.stop();
    playback.current = await playOnStage(videoRef.current, {
      clip,
      bedGain: 1,
      ...(take.buffer
        ? {
            voices: [
              { buffer: take.buffer, effect, gain: take.gain, offsetMs: take.baseOffset + manual },
            ],
          }
        : {
            streamVoices: [
              { src: take.url!, effect, gain: take.gain, offsetMs: take.baseOffset + manual },
            ],
          }),
      onPosition,
    });
    await playback.current.done;
    setPos(-1);
  };

  const submit = () => {
    if (!take) return;
    playback.current?.stop();
    if (!prefs.tipsSeen) prefs.set({ tipsSeen: true });
    onSubmit({ blob: take.blob, offsetMs: take.baseOffset + manual, effect, gain: take.gain });
  };

  const segments = useMemo(
    () =>
      clip?.manifest.lines.map((l) => {
        const ri = clip.manifest.roles.findIndex((r) => r.id === l.role);
        return {
          startMs: l.startMs,
          endMs: l.endMs,
          color: clip.manifest.roles[ri]?.color ?? "var(--accent)",
          pattern: ri % 3,
          mine: !myRoles || myRoles.includes(l.role),
          label: localized(l.text, lang),
        };
      }) ?? [],
    [clip, myRoles, lang],
  );

  const next = useMemo(() => {
    if (!clip || pos < 0) return null;
    const l = clip.manifest.lines.find((x) => x.startMs > pos + 1000);
    if (!l) return null;
    const role = clip.manifest.roles.find((r) => r.id === l.role);
    return {
      who: role ? localized(role.name, lang) : "",
      text: localized(l.text, lang),
      s: ((l.startMs - pos) / 1000).toFixed(1),
    };
  }, [clip, pos, lang]);

  if (loadError) return <p className="error-text">{t("err.generic")}</p>;
  if (mic.error) return <MicHelp error={mic.error} onRetry={() => void mic.open()} />;

  const showTips = !prefs.tipsSeen && (mode === "menu" || mode === "countdown");

  return (
    <div className="recording">
      <Stage
        ref={videoRef}
        manifest={clip?.manifest}
        positionMs={pos}
        poster={clip?.posterUrl}
        myRoles={myRoles}
        hideText={improv}
        overlay={
          <>
            {mode === "loading" && (
              <div className="stage__loading">
                {t("rec.loading")} {Math.round(loadPct * 100)}%
              </div>
            )}
            {mode === "countdown" && count > 0 && <Countdown n={count} />}
            {showTips && <div className="tip tip--line">{t("tip.line")}</div>}
          </>
        }
      />

      {clip && (
        <LineTimeline
          durationMs={clip.manifest.durationMs}
          segments={segments}
          positionMs={pos >= 0 ? pos : undefined}
        />
      )}
      {next && (mode === "recording" || mode === "rehearsing") && !improv && (
        <p className="dr-muted next-line">{t("rec.next", next)}</p>
      )}
      {myRoles && clip && (
        <p className="dr-muted">
          {t("rec.yourRoles", {
            roles: myRoles
              .map(
                (id) =>
                  localized(clip.manifest.roles.find((r) => r.id === id)?.name ?? {}, lang) || id,
              )
              .join(", "),
          })}
        </p>
      )}

      <div className="recording__controls">
        <span className="row">
          🎤 <LevelMeter level={level} />
          {showTips && <span className="tip tip--inline">{t("tip.meter")}</span>}
        </span>
        {silentHint && mode === "recording" && (
          <span className="warn-text" role="status">
            {t("rec.cantHear")}
          </span>
        )}

        {mode === "menu" && (
          <div className="row">
            {clip && rehearsalAllowed(clip.manifest.durationMs) && (
              <Button onClick={rehearse}>{t("rec.rehearse")}</Button>
            )}
            <Button
              variant="primary"
              onClick={record}
              disabled={!mic.stream || attempts >= attemptsAllowed}
            >
              {t("rec.start")}
            </Button>
          </div>
        )}
        {mode === "rehearsing" && (
          <Button onClick={() => playback.current?.stop()}>{t("rec.skipRehearsal")}</Button>
        )}
        {(mode === "recording" || mode === "countdown") && (
          <div className="row">
            <span className="rec-dot">● {t("rec.attempt", { a: attempts + 1 })}</span>
            <Button variant="danger" onClick={stopEarly} disabled={mode === "countdown"}>
              {t("rec.stop")}
            </Button>
            <Button variant="ghost" onClick={restart}>
              {t("rec.restart")}
            </Button>
          </div>
        )}
        {mode === "review" && take && (
          <div className="review">
            <h3>{t("rec.review")}</h3>
            <SyncSlider value={manual} onChange={setManual} label={t("rec.sync")} />
            <div className="dr-effects" role="group" aria-label={t("rec.effect")}>
              {EFFECTS.map((e) => (
                <Button
                  key={e}
                  size="small"
                  aria-pressed={effect === e}
                  onClick={() => setEffect(e)}
                >
                  {EFFECT_LABELS[e].icon} {EFFECT_LABELS[e][lang]}
                </Button>
              ))}
            </div>
            <div className="row">
              <Button onClick={listen}>▶</Button>
              <Button onClick={record} disabled={attempts >= attemptsAllowed || busy}>
                {t("rec.rerecord", { n: attemptsAllowed - attempts })}
              </Button>
              <Button variant="primary" onClick={submit} disabled={busy}>
                {submitLabel ?? t("rec.send")}
              </Button>
            </div>
            {!prefs.tipsSeen && <span className="tip tip--inline">{t("tip.redo")}</span>}
            <p className="dr-muted small">{t("rec.privacy")}</p>
          </div>
        )}
      </div>
      <p className="rotate-hint">{t("rec.rotate")}</p>
    </div>
  );
}

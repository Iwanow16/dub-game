import { useEffect, useState } from "react";
import {
  LevelMeter as Meter,
  TakeRecorder,
  decode,
  detectOnsets,
  estimateLatency,
} from "@dubroom/audio";
import { Button, LevelMeter } from "@dubroom/ui";
import { audioContext, ctxTimeToPerf, playClicks, unlockAudio } from "../lib/audio.ts";
import { useMic } from "../lib/mic.ts";
import { usePrefs } from "../lib/prefs.ts";
import { useT } from "../lib/i18n.ts";
import { MicHelp } from "../components/MicHelp.tsx";

/** Sound check + one-time latency calibration (§12.2, §20.2). */
export function SoundCheck({ onDone }: { onDone: () => void }) {
  const t = useT();
  const prefs = usePrefs();
  const mic = useMic();
  const [level, setLevel] = useState(0);
  const [calib, setCalib] = useState<"idle" | "running" | "ok" | "fail">(
    prefs.latencyMs != null ? "ok" : "idle",
  );

  useEffect(() => {
    if (!mic.stream) return;
    const m = new Meter(audioContext(), mic.stream);
    let raf = 0;
    const loop = () => {
      setLevel(m.level());
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      m.dispose();
    };
  }, [mic.stream]);

  const askMic = async () => {
    await unlockAudio();
    await mic.open();
  };

  const calibrate = async () => {
    if (!mic.stream) return;
    await unlockAudio();
    setCalib("running");
    try {
      const rec = new TakeRecorder(mic.stream);
      const recStart = await rec.start();
      const ctx = audioContext();
      const clickTimes = playClicks(4, 0.6, 0.8);
      await new Promise((r) => setTimeout(r, (clickTimes[3]! - ctx.currentTime) * 1000 + 900));
      const take = await rec.stop();
      const buf = await decode(ctx, take.blob);
      const clicksMs = clickTimes.map((ct) => ctxTimeToPerf(ctx, ct) - recStart);
      const onsets = detectOnsets(buf.getChannelData(0), buf.sampleRate);
      const r = estimateLatency(clicksMs, onsets);
      if (r && r.latencyMs < 600) {
        prefs.set({ latencyMs: r.latencyMs });
        setCalib("ok");
      } else setCalib("fail");
    } catch {
      setCalib("fail");
    }
  };

  const finish = () => {
    prefs.set({ soundChecked: true });
    onDone();
  };

  return (
    <div className="page">
      <main className="soundcheck">
        <h1>{t("sound.title")}</h1>
        <label className="check check--big">
          <input
            type="checkbox"
            checked={prefs.headphones}
            onChange={(e) => {
              prefs.set({ headphones: e.target.checked });
              mic.close();
            }}
          />
          🎧 {t("sound.headphones")}
        </label>
        <p className="dr-muted">
          {prefs.headphones ? t("sound.headphonesHint") : t("sound.noHeadphones")}
        </p>

        {!mic.stream && (
          <section className="dr-card">
            <p>{t("sound.micWhy")}</p>
            <Button variant="primary" onClick={askMic}>
              🎤 {t("sound.micAsk")}
            </Button>
            {mic.error && <MicHelp error={mic.error} onRetry={askMic} />}
          </section>
        )}

        {mic.stream && (
          <>
            <section className="dr-card soundcheck__meter">
              <LevelMeter level={level} bars={12} />
              <span>{t("sound.say")}</span>
            </section>
            <section className="dr-card">
              <h2>{t("sound.calibrate")}</h2>
              <p className="dr-muted">{t("sound.calibrateHint")}</p>
              <div className="row">
                <Button onClick={calibrate} disabled={calib === "running"}>
                  👏 {t("sound.calibrateStart")}
                </Button>
                {calib === "ok" && (
                  <span className="ok-text">
                    ✓ {t("sound.calibrated", { ms: prefs.latencyMs ?? 0 })}
                  </span>
                )}
                {calib === "fail" && <span className="error-text">{t("sound.calibrateFail")}</span>}
              </div>
            </section>
          </>
        )}

        <div className="actions-end">
          <Button variant="ghost" onClick={finish}>
            {t("sound.skip")}
          </Button>
          <Button variant="primary" onClick={finish} disabled={!mic.stream}>
            {t("sound.continue")}
          </Button>
        </div>
      </main>
    </div>
  );
}

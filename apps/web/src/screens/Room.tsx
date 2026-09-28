import { useEffect, useState } from "react";
import { Button, useToast } from "@dubroom/ui";
import { game, roomExists } from "../net/client.ts";
import { useGame } from "../net/store.ts";
import { useIdentity } from "../lib/identity.ts";
import { usePrefs } from "../lib/prefs.ts";
import { navigate } from "../lib/router.ts";
import { useT, type MsgKey } from "../lib/i18n.ts";
import { Profile } from "./Profile.tsx";
import { SoundCheck } from "./SoundCheck.tsx";
import { NotFound } from "./NotFound.tsx";
import { GameView } from "./GameView.tsx";

type Step = "checking" | "profile" | "sound" | "game" | "missing";

/** Entry flow for /r/:code — link → profile (skipped if known) → sound check (once) → game. */
export function Room({ code }: { code: string }) {
  const t = useT();
  const toast = useToast();
  const hasProfile = useIdentity((s) => s.hasProfile);
  const soundChecked = usePrefs((s) => s.soundChecked);
  const [step, setStep] = useState<Step>("checking");
  const fatal = useGame((s) => s.fatal);
  const lastError = useGame((s) => s.lastError);

  useEffect(() => {
    let alive = true;
    roomExists(code)
      .then((ok) => {
        if (!alive) return;
        if (!ok) setStep("missing");
        else setStep(!hasProfile ? "profile" : !soundChecked ? "sound" : "game");
      })
      .catch(() => alive && setStep(!hasProfile ? "profile" : "game"));
    return () => {
      alive = false;
    };
    // decide the first step once per code
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // settings → "recalibrate" sends the player back to the sound check
  useEffect(() => {
    if (step === "game" && !soundChecked) setStep("sound");
  }, [soundChecked, step]);

  useEffect(() => {
    if (step !== "game") return;
    void game.connect(code);
    return () => game.disconnect();
  }, [step, code]);

  useEffect(() => {
    if (lastError)
      toast(
        {
          text:
            lastError.message && lastError.code === "not_allowed"
              ? lastError.message
              : t(errKey(lastError.code)),
          kind: "error",
        },
        3500,
      );
  }, [lastError, toast, t]);

  if (step === "checking") return <div className="page page--center" aria-busy="true" />;
  if (step === "missing" || fatal === "room_not_found") return <NotFound />;
  if (fatal) {
    return (
      <div className="page page--center">
        <div className="dr-card center-card">
          <h1>{t(errKey(fatal))}</h1>
          <Button variant="primary" onClick={() => navigate("/")}>
            {t("nf.home")}
          </Button>
        </div>
      </div>
    );
  }
  if (step === "profile")
    return <Profile onDone={() => setStep(soundChecked ? "game" : "sound")} />;
  if (step === "sound") return <SoundCheck onDone={() => setStep("game")} />;
  return <GameView />;
}

function errKey(code: string): MsgKey {
  const known = [
    "room_not_found",
    "room_full",
    "room_locked",
    "kicked",
    "rate_limited",
    "bad_name",
  ];
  return (known.includes(code) ? `err.${code}` : "err.generic") as MsgKey;
}

import type { MicError } from "@dubroom/audio";
import { Button } from "@dubroom/ui";
import { browserFamily } from "../lib/mic.ts";
import { useT } from "../lib/i18n.ts";

/** "No dead ends" (§20.1): every mic error explains what to do, per browser. */
export function MicHelp({ error, onRetry }: { error: MicError; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="mic-help" role="alert">
      <strong>{error === "denied" ? t("mic.denied") : t(`mic.${error}`)}</strong>
      {error === "denied" && <p>{t(`mic.denied.${browserFamily()}`)}</p>}
      <div className="row">
        <Button onClick={onRetry}>{t("mic.retry")}</Button>
        <a href="/help/faq.html#microphone" target="_blank" rel="noreferrer">
          {t("err.faq")}
        </a>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { localized, type CatalogEntry } from "@dubroom/shared";
import { Button } from "@dubroom/ui";
import { fetchCatalog } from "../lib/media.ts";
import { useLang, useT } from "../lib/i18n.ts";
import { TopBar } from "../components/TopBar.tsx";
import { RecordingFlow } from "../components/RecordingFlow.tsx";

/** Solo "try it" mode (§23.2): record a take without a room to check the mic and sync. */
export function Practice() {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const [clips, setClips] = useState<CatalogEntry[] | null>(null);
  const [index, setIndex] = useState(0);
  const [round, setRound] = useState(0);

  useEffect(() => {
    fetchCatalog()
      .then((c) => setClips([...c].sort((a, b) => a.durationMs - b.durationMs)))
      .catch(() => setClips([]));
  }, []);

  const clip = clips?.[index % Math.max(1, clips.length)];
  return (
    <div className="page">
      <TopBar />
      <main className="practice">
        <h1>{t("practice.title")}</h1>
        <p className="dr-muted">{t("practice.hint")}</p>
        {clips && clips.length === 0 && <p>{t("practice.empty")}</p>}
        {clips && clips.length > 1 && (
          <select
            className="dr-input practice__select"
            value={index}
            onChange={(e) => setIndex(Number(e.target.value))}
          >
            {clips.map((c, i) => (
              <option key={c.id} value={i}>
                {localized(c.title, lang)} · {Math.round(c.durationMs / 1000)} s
              </option>
            ))}
          </select>
        )}
        {clip && (
          <RecordingFlow
            key={`${clip.id}-${round}`}
            clipEntry={clip}
            myRoles={null}
            submitLabel={t("practice.again")}
            onSubmit={() => setRound((r) => r + 1)}
          />
        )}
        {clip && (
          <Button variant="ghost" onClick={() => setRound((r) => r + 1)}>
            ↺ {t("practice.again")}
          </Button>
        )}
      </main>
    </div>
  );
}

import { useEffect, useState } from "react";
import { normalizeRoomCode } from "@dubroom/shared";
import { Button, useToast } from "@dubroom/ui";
import { createRoom } from "../net/client.ts";
import { navigate } from "../lib/router.ts";
import { unlockAudio } from "../lib/audio.ts";
import { fetchCatalog } from "../lib/media.ts";
import { useT } from "../lib/i18n.ts";
import { TopBar } from "../components/TopBar.tsx";

export function Home() {
  const t = useT();
  const toast = useToast();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [codeError, setCodeError] = useState(false);

  const create = async () => {
    setBusy(true);
    void unlockAudio();
    try {
      const c = await createRoom();
      navigate(`/r/${c}`);
    } catch {
      toast({ text: t("err.create"), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const join = (e: React.FormEvent) => {
    e.preventDefault();
    const c = normalizeRoomCode(code);
    if (!c) {
      setCodeError(true);
      return;
    }
    void unlockAudio();
    navigate(`/r/${c}`);
  };

  return (
    <div className="page">
      <TopBar />
      <main className="home">
        <h1 className="home__title">{t("app.tagline")}</h1>
        <Button variant="primary" onClick={create} disabled={busy} className="home__create">
          {t("home.create")}
        </Button>
        <form className="home__join" onSubmit={join}>
          <label className="dr-field">
            <span>{t("home.codeLabel")}</span>
            <input
              className="dr-input dr-input--code"
              value={code}
              maxLength={6}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              inputMode="text"
              placeholder="K7QX2"
              aria-invalid={codeError}
              aria-describedby={codeError ? "code-err" : undefined}
              onChange={(e) => {
                setCode(e.target.value.toUpperCase());
                setCodeError(false);
              }}
            />
          </label>
          <Button type="submit">{t("home.join")}</Button>
          {codeError && (
            <p id="code-err" className="error-text" role="alert">
              {t("home.badCode")}
            </p>
          )}
        </form>
        <div className="home__demo" aria-hidden>
          <DemoLoop />
        </div>
        <nav className="home__links">
          <a href="/help/" className="dr-btn dr-btn--ghost">
            {t("home.howto")}
          </a>
          <Button variant="ghost" onClick={() => navigate("/try")}>
            {t("home.try")}
          </Button>
        </nav>
      </main>
    </div>
  );
}

/** Looping silent preview of a published clip (§20.3 "Главная"). */
function DemoLoop() {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchCatalog()
      .then((clips) => alive && setSrc(clips.find((x) => x.previewUrl)?.previewUrl ?? ""))
      .catch(() => alive && setSrc(""));
    return () => {
      alive = false;
    };
  }, []);
  if (!src) return <div className="home__demo-placeholder">🎬</div>;
  return <video src={src} autoPlay muted loop playsInline className="home__demo-video" />;
}

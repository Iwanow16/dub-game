import { useState } from "react";
import { normalizeRoomCode } from "@dubroom/shared";
import { Button } from "@dubroom/ui";
import { navigate } from "../lib/router.ts";
import { useT } from "../lib/i18n.ts";
import { TopBar } from "../components/TopBar.tsx";

/** 404 with a code field (§20.6) — never a dead end. */
export function NotFound() {
  const t = useT();
  const [code, setCode] = useState("");
  const valid = normalizeRoomCode(code);
  return (
    <div className="page">
      <TopBar />
      <main className="page--center">
        <div className="dr-card center-card">
          <h1>{t("nf.title")}</h1>
          <p className="dr-muted">{t("nf.text")}</p>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) navigate(`/r/${valid}`);
            }}
          >
            <input
              className="dr-input dr-input--code"
              value={code}
              maxLength={6}
              aria-label={t("home.codeLabel")}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
            <Button type="submit" disabled={!valid}>
              {t("home.join")}
            </Button>
          </form>
          <Button variant="ghost" onClick={() => navigate("/")}>
            {t("nf.home")}
          </Button>
        </div>
      </main>
    </div>
  );
}

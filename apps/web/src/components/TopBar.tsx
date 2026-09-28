import { useState } from "react";
import { Button, Modal } from "@dubroom/ui";
import { useLang, useT } from "../lib/i18n.ts";
import { applyVisualPrefs, usePrefs, type Quality } from "../lib/prefs.ts";
import { navigate } from "../lib/router.ts";

export function TopBar({ right }: { right?: React.ReactNode }) {
  const t = useT();
  const { lang, setLang } = useLang();
  const [open, setOpen] = useState(false);
  return (
    <header className="topbar">
      <a
        href="/"
        className="topbar__logo"
        onClick={(e) => {
          e.preventDefault();
          navigate("/");
        }}
      >
        🎬 DubRoom
      </a>
      <div className="topbar__right">
        {right}
        <select
          className="dr-input topbar__lang"
          aria-label={t("settings.lang")}
          value={lang}
          onChange={(e) => setLang(e.target.value as "ru" | "en")}
        >
          <option value="ru">RU</option>
          <option value="en">EN</option>
        </select>
        <Button
          variant="ghost"
          className="dr-btn--icon"
          aria-label={t("settings.title")}
          onClick={() => setOpen(true)}
        >
          ⚙
        </Button>
      </div>
      {open && <SettingsModal onClose={() => setOpen(false)} />}
    </header>
  );
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const prefs = usePrefs();
  const update = (p: Partial<typeof prefs>) => {
    prefs.set(p);
    applyVisualPrefs({ ...usePrefs.getState() });
  };
  return (
    <Modal title={t("settings.title")} onClose={onClose}>
      <div className="form-grid">
        <label className="dr-field">
          <span>{t("settings.subs")}</span>
          <select
            className="dr-input"
            value={prefs.subtitleScale}
            onChange={(e) => update({ subtitleScale: Number(e.target.value) as 1 | 1.25 | 1.5 })}
          >
            <option value={1}>A</option>
            <option value={1.25}>A+</option>
            <option value={1.5}>A++</option>
          </select>
        </label>
        <label className="dr-field">
          <span>{t("settings.quality")}</span>
          <select
            className="dr-input"
            value={String(prefs.quality)}
            onChange={(e) =>
              update({
                quality: (e.target.value === "auto" ? "auto" : Number(e.target.value)) as Quality,
              })
            }
          >
            <option value="auto">{t("settings.quality.auto")}</option>
            <option value="720">720p</option>
            <option value="480">480p</option>
            <option value="360">360p</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={prefs.uiSounds}
            onChange={(e) => update({ uiSounds: e.target.checked })}
          />
          {t("settings.sounds")}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={prefs.lightTheme}
            onChange={(e) => update({ lightTheme: e.target.checked })}
          />
          {t("settings.theme")}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={prefs.headphones}
            onChange={(e) => update({ headphones: e.target.checked })}
          />
          {t("sound.headphones")}
        </label>
        <Button
          onClick={() => {
            update({ soundChecked: false, latencyMs: null });
            onClose();
          }}
        >
          {t("settings.recalibrate")}
        </Button>
        <a href="/help/" className="dr-btn dr-btn--ghost">
          {t("help.link")}
        </a>
      </div>
    </Modal>
  );
}

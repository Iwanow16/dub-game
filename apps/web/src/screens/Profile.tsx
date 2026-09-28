import { useState } from "react";
import { AVATAR_PRESETS, NAME_MAX, randomAvatar, sanitizeName } from "@dubroom/shared";
import { Avatar, AvatarEditor, Button } from "@dubroom/ui";
import { useIdentity } from "../lib/identity.ts";
import { useLang, useT } from "../lib/i18n.ts";
import { navigate } from "../lib/router.ts";
import { unlockAudio } from "../lib/audio.ts";

/** Name + avatar (US-1). Pre-filled from the previous visit. */
export function Profile({ onDone }: { onDone: () => void }) {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const id = useIdentity();
  const [name, setName] = useState(id.name);
  const [avatar, setAvatar] = useState(id.avatar);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = sanitizeName(name);
    if (!r.ok) {
      setError(r.error === "length" ? t("profile.err.length") : t("profile.err.profanity"));
      return;
    }
    void unlockAudio();
    id.setProfile(r.name, avatar);
    onDone();
  };

  return (
    <div className="page">
      <form className="profile" onSubmit={submit}>
        <div className="profile__head">
          <Button variant="ghost" onClick={() => navigate("/")}>
            {t("profile.back")}
          </Button>
          <h1>{t("profile.title")}</h1>
        </div>
        <div className="profile__body">
          <div className="profile__avatar">
            <Avatar spec={avatar} size={200} title={name || "?"} />
            <Button onClick={() => setAvatar(randomAvatar())}>{t("profile.random")}</Button>
          </div>
          <div className="profile__fields">
            <label className="dr-field">
              <span>
                {t("profile.name")} · {[...name].length}/{NAME_MAX}
              </span>
              <input
                className="dr-input"
                value={name}
                maxLength={NAME_MAX + 4}
                autoFocus
                autoComplete="nickname"
                aria-invalid={Boolean(error)}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
              />
            </label>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <AvatarEditor value={avatar} onChange={setAvatar} lang={lang} />
          </div>
        </div>
        <div>
          <p className="dr-muted">{t("profile.presets")}</p>
          <div className="presets" role="list">
            {AVATAR_PRESETS.map((p, i) => (
              <button
                key={i}
                type="button"
                role="listitem"
                className="presets__item"
                aria-label={`${t("profile.presets")} ${i + 1}`}
                onClick={() => setAvatar(p)}
              >
                <Avatar spec={p} size={48} />
              </button>
            ))}
          </div>
        </div>
        <div className="actions-end">
          <Button type="submit" variant="primary">
            {t("profile.next")}
          </Button>
        </div>
      </form>
    </div>
  );
}

import { useEffect, useState } from "react";
import { localized, type CatalogEntry, type RoomSnapshot } from "@dubroom/shared";
import { Avatar } from "@dubroom/ui";
import { game } from "../net/client.ts";
import { selectMe, useGame } from "../net/store.ts";
import { preloadCandidates } from "../lib/media.ts";
import { sounds } from "../lib/audio.ts";
import { useLang, useT } from "../lib/i18n.ts";

export function Pick({ room }: { room: RoomSnapshot }) {
  const t = useT();
  const me = useGame(selectMe);
  const r = room.round!;
  const byHost = room.settings.clipPick === "host";
  const canPick = byHost ? Boolean(me?.isHost) : Boolean(me && r.participants.includes(me.id));
  const myPick = me ? r.pickVotes[me.id] : undefined;

  useEffect(() => {
    preloadCandidates(r.candidates);
  }, [r.candidates]);

  return (
    <div className="pick">
      <div className="pick__cards">
        {r.candidates.map((c) => (
          <ClipCard
            key={c.id}
            clip={c}
            selected={myPick === c.id}
            disabled={!canPick}
            voters={Object.entries(r.pickVotes)
              .filter(([, id]) => id === c.id)
              .map(([pid]) => room.players.find((p) => p.id === pid))
              .filter((p) => p !== undefined)}
            onPick={() => {
              sounds.vote();
              game.send({ t: "pickClip", clipId: c.id });
            }}
          />
        ))}
      </div>
      <p className="dr-muted center">{byHost ? t("pick.host") : t("pick.vote")}</p>
    </div>
  );
}

function ClipCard({
  clip,
  selected,
  disabled,
  voters,
  onPick,
}: {
  clip: CatalogEntry;
  selected: boolean;
  disabled: boolean;
  voters: RoomSnapshot["players"];
  onPick: () => void;
}) {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      className={`clip-card ${selected ? "clip-card--selected" : ""}`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      <div className="clip-card__media">
        <img src={clip.posterUrl} alt="" loading="lazy" />
        {hover && clip.previewUrl && (
          <video src={clip.previewUrl} autoPlay muted loop playsInline />
        )}
        <span className="clip-card__rating">{clip.ageRating}</span>
      </div>
      <strong className="clip-card__title">{localized(clip.title, lang)}</strong>
      <span className="dr-muted">
        {t("pick.sec", { n: Math.round(clip.durationMs / 1000) })} ·{" "}
        {t("pick.roles", { n: clip.rolesCount })}
      </span>
      <span className="clip-card__voters">
        {voters.map((p) => (
          <Avatar key={p.id} spec={p.avatar} size={24} title={p.name} />
        ))}
      </span>
    </button>
  );
}

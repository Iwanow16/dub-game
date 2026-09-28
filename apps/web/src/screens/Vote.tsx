import type { RoomSnapshot } from "@dubroom/shared";
import { Button } from "@dubroom/ui";
import { game } from "../net/client.ts";
import { selectMe, useGame } from "../net/store.ts";
import { useEntryPlayer } from "../lib/useEntryPlayer.ts";
import { sounds } from "../lib/audio.ts";
import { useT } from "../lib/i18n.ts";
import { Stage } from "../components/Stage.tsx";

/** Voting (§13): one vote, not for yourself, changeable until the timer ends. */
export function Vote({ room }: { room: RoomSnapshot }) {
  const t = useT();
  const me = useGame(selectMe);
  const myVote = useGame((s) => s.myVote);
  const r = room.round!;
  const player = useEntryPlayer(r.clip, r.entries);
  const playable = r.entries.filter((e) => !e.lost);

  return (
    <div className="vote">
      <Stage
        ref={player.videoRef}
        manifest={player.clip?.manifest}
        positionMs={player.pos}
        poster={player.clip?.posterUrl}
        showSubtitles={room.settings.mode !== "improv"}
      />
      <h2>{t("vote.title")}</h2>
      <p className="dr-muted">
        {t("vote.hint")}
        {me?.spectator ? ` · ${t("vote.spectator")}` : ""}
      </p>
      <div className="vote__cards" role="radiogroup" aria-label={t("vote.title")}>
        {playable.map((e, i) => {
          const mine = e.id === r.myEntryId;
          const chosen = myVote === e.id;
          return (
            <div
              key={e.id}
              className={`vote-card ${chosen ? "vote-card--chosen" : ""} ${mine ? "vote-card--mine" : ""}`}
            >
              <button
                type="button"
                role="radio"
                aria-checked={chosen}
                disabled={mine}
                className="vote-card__main"
                onClick={() => {
                  sounds.vote();
                  game.send({ t: "vote", entryId: e.id });
                }}
              >
                <strong>{t("watch.take", { n: i + 1 })}</strong>
                {mine && <span className="dr-muted">{t("vote.you")}</span>}
                {chosen && <span className="ok-text">✓ {t("vote.voted")}</span>}
              </button>
              <Button
                size="small"
                aria-label={`${t("watch.take", { n: i + 1 })} ▶`}
                onClick={() => (player.playing === e.id ? player.stop() : void player.play(e))}
              >
                {player.playing === e.id ? "■" : t("vote.replay")}
              </Button>
            </div>
          );
        })}
      </div>
      <p className="dr-muted">{r.votesCast} ✓</p>
    </div>
  );
}

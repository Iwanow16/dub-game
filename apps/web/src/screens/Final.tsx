import { useEffect } from "react";
import type { RoomSnapshot } from "@dubroom/shared";
import { Button, Scoreboard } from "@dubroom/ui";
import { game } from "../net/client.ts";
import { selectMe, useGame } from "../net/store.ts";
import { navigate } from "../lib/router.ts";
import { sounds } from "../lib/audio.ts";
import { useEntryPlayer } from "../lib/useEntryPlayer.ts";
import { useT } from "../lib/i18n.ts";
import { Stage } from "../components/Stage.tsx";
import { Speakers } from "./Watch.tsx";

export function Final({ room }: { room: RoomSnapshot }) {
  const t = useT();
  const me = useGame(selectMe);
  const best = room.bestOfGame;
  const player = useEntryPlayer(best?.clip ?? null, best ? [best.entry] : []);
  const rows = room.players
    .filter((p) => !p.spectator || p.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score }));
  const top = rows[0];

  useEffect(() => {
    sounds.fanfare();
  }, []);

  return (
    <div className="final">
      <h1 className="center">
        🏆 {top ? t("final.winner", { name: top.name }) : t("final.title")}
      </h1>
      <Scoreboard rows={rows} />
      {best && (
        <section className="final__best">
          <Stage
            ref={player.videoRef}
            manifest={player.clip?.manifest}
            positionMs={player.pos}
            poster={player.clip?.posterUrl}
          />
          {player.playing && (
            <Speakers entry={best.entry} room={room} levels={player.levels} number={1} />
          )}
        </section>
      )}
      <div className="row row--center">
        {best && (
          <Button
            onClick={() => (player.playing ? player.stop() : void player.play(best.entry))}
            disabled={!player.clip}
          >
            {t("final.rewatch")}
          </Button>
        )}
        {me?.isHost && (
          <Button variant="primary" onClick={() => game.send({ t: "playAgain" })}>
            {t("final.again")}
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => {
            game.leave();
            navigate("/");
          }}
        >
          {t("final.exit")}
        </Button>
      </div>
    </div>
  );
}

import { useEffect } from "react";
import { REACTIONS, type RoomSnapshot } from "@dubroom/shared";
import { ReactionBar, Scoreboard } from "@dubroom/ui";
import { game } from "../net/client.ts";
import { sounds } from "../lib/audio.ts";
import { useT } from "../lib/i18n.ts";

export function Results({ room }: { room: RoomSnapshot }) {
  const t = useT();
  const r = room.round!;
  const results = r.results ?? [];
  const nameOf = (entryId: string) =>
    r.entries
      .find((e) => e.id === entryId)
      ?.playerIds.map((id) => room.players.find((p) => p.id === id)?.name ?? "?")
      .join(" + ") ?? "?";
  const winner = results.find((x) => x.winner);
  const audience = results.find((x) => x.audienceAward);

  useEffect(() => {
    if (winner) sounds.fanfare();
  }, [winner]);

  const delta = (playerId: string) => {
    const entry = r.entries.find((e) => e.playerIds.includes(playerId));
    return entry ? (results.find((x) => x.entryId === entry.id)?.points ?? 0) : 0;
  };
  const rows = room.players
    .filter((p) => !p.spectator || p.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, delta: delta(p.id) }));

  return (
    <div className="results">
      <h2 className="results__winner" aria-live="polite">
        {winner
          ? t("results.best", {
              name: nameOf(winner.entryId),
              n: winner.votes + winner.spectatorVotes,
            })
          : t("results.noVotes")}
      </h2>
      {audience && <p>👏 {t("results.audience", { name: nameOf(audience.entryId) })}</p>}
      <Scoreboard rows={rows} />
      <ReactionBar
        emojis={REACTIONS}
        onReact={(emoji) =>
          game.send({ t: "reaction", emoji: emoji as (typeof REACTIONS)[number] })
        }
      />
    </div>
  );
}

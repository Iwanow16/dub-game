import { useEffect } from "react";
import { REACTIONS, type Entry, type RoomSnapshot } from "@dubroom/shared";
import { Avatar, ReactionBar } from "@dubroom/ui";
import { game } from "../net/client.ts";
import { useGame } from "../net/store.ts";
import { useEntryPlayer } from "../lib/useEntryPlayer.ts";
import { useT } from "../lib/i18n.ts";
import { Stage } from "../components/Stage.tsx";

/** Synchronized playback of every dub (§13, US-4): the server says when, all clients start together. */
export function Watch({ room }: { room: RoomSnapshot }) {
  const t = useT();
  const r = room.round!;
  const playAt = useGame((s) => s.playAt);
  const offset = useGame((s) => s.serverOffset);
  const player = useEntryPlayer(r.clip, r.entries);
  const entry = playAt ? r.entries.find((e) => e.id === playAt.entryId) : undefined;
  const { play, clip } = player;

  useEffect(() => {
    if (!playAt || !entry || !clip) return;
    // server time → client time
    void play(entry, playAt.startAt - offset);
    // restart only when a new entry is scheduled or the clip becomes ready
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playAt?.entryId, playAt?.startAt, clip]);

  const playable = r.entries.filter((e) => !e.lost);
  const number = entry ? playable.findIndex((e) => e.id === entry.id) + 1 : 0;

  return (
    <div className="watch">
      <Stage
        ref={player.videoRef}
        manifest={player.clip?.manifest}
        positionMs={player.pos}
        poster={player.clip?.posterUrl}
        showSubtitles={room.settings.mode !== "improv"}
      />
      <div className="watch__bar">
        {entry && <Speakers entry={entry} room={room} levels={player.levels} number={number} />}
        <ReactionBar
          emojis={REACTIONS}
          onReact={(emoji) =>
            game.send({ t: "reaction", emoji: emoji as (typeof REACTIONS)[number] })
          }
        />
      </div>
      {r.entries.some((e) => e.lost) && <p className="dr-muted">⚠ {t("watch.lost")}</p>}
    </div>
  );
}

export function Speakers({
  entry,
  room,
  levels,
  number,
}: {
  entry: Entry;
  room: RoomSnapshot;
  levels: Record<string, number>;
  number: number;
}) {
  const t = useT();
  const anonymous = entry.playerIds.length === 0;
  if (anonymous) {
    const level = Math.max(0, ...Object.values(levels));
    return (
      <div className="speakers">
        <span className={`speaker-anon ${level > 0.1 ? "speaker-anon--on" : ""}`}>🎭</span>
        <strong>{t("watch.take", { n: number })}</strong>
      </div>
    );
  }
  return (
    <div className="speakers">
      {entry.playerIds.map((id) => {
        const p = room.players.find((x) => x.id === id);
        if (!p) return null;
        return (
          <span key={id} className="speaker">
            <Avatar spec={p.avatar} size={48} mouthOpen={levels[id] ?? 0} title={p.name} />
            <span>{t("watch.speaking", { name: p.name })}</span>
          </span>
        );
      })}
    </div>
  );
}

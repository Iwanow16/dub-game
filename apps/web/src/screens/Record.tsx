import { useState } from "react";
import type { RoomSnapshot } from "@dubroom/shared";
import { PlayerCard, useToast } from "@dubroom/ui";
import { game } from "../net/client.ts";
import { selectMe, useGame } from "../net/store.ts";
import { uploadDub } from "../lib/media.ts";
import { useT } from "../lib/i18n.ts";
import { RecordingFlow, type FinishedTake } from "../components/RecordingFlow.tsx";
import { WaitingFacts } from "./GameView.tsx";

export function Record({ room }: { room: RoomSnapshot }) {
  const me = useGame(selectMe);
  const r = room.round!;
  const participant = me && r.participants.includes(me.id);
  if (!participant || !r.clip) return <RecordWaiting room={room} spectator />;
  if (me.status === "done") return <RecordWaiting room={room} />;
  return <RecordTake room={room} />;
}

function RecordTake({ room }: { room: RoomSnapshot }) {
  const t = useT();
  const toast = useToast();
  const me = useGame(selectMe)!;
  const ticket = useGame((s) => s.ticket);
  const r = room.round!;
  const [progress, setProgress] = useState<number | null>(null);
  const myRoles = room.settings.mode === "roles" ? (r.roleAssignment[me.id] ?? null) : null;

  const submit = async (take: FinishedTake) => {
    if (!ticket || ticket.round !== r.index) {
      toast({ text: t("rec.uploadFail"), kind: "error" });
      return;
    }
    setProgress(0);
    game.send({ t: "status", status: "uploading", progress: 0 });
    let last = 0;
    try {
      const { receipt } = await uploadDub(take.blob, ticket.ticket, (p) => {
        setProgress(p);
        if (p - last > 0.2) {
          last = p;
          game.send({ t: "status", status: "uploading", progress: p });
        }
      });
      game.send({
        t: "dubUploaded",
        receipt,
        offsetMs: take.offsetMs,
        effect: take.effect,
        gain: take.gain,
      });
    } catch {
      setProgress(null);
      toast({
        text: t("rec.uploadFail"),
        kind: "error",
        action: { label: t("mic.retry"), onClick: () => void submit(take) },
      });
    }
  };

  return (
    <div className="record">
      <RecordingFlow
        clipEntry={r.clip!}
        myRoles={myRoles}
        improv={room.settings.mode === "improv"}
        onLoaded={() => game.send({ t: "ready" })}
        onRecordingChange={(rec) => rec && game.send({ t: "status", status: "recording" })}
        onSubmit={(take) => void submit(take)}
        busy={progress !== null}
      />
      {progress !== null && (
        <p role="status" className="center">
          {t("rec.uploading", { p: Math.round(progress * 100) })}
        </p>
      )}
    </div>
  );
}

function RecordWaiting({ room, spectator }: { room: RoomSnapshot; spectator?: boolean }) {
  const t = useT();
  const r = room.round!;
  const statusIcon: Record<string, string> = {
    idle: "…",
    loading: "⏳",
    ready: "🎬",
    recording: "🎙",
    uploading: "⬆",
    done: "✓",
  };
  return (
    <div className="waiting">
      <h2>{spectator ? t("rec.spectator") : t("rec.done")}</h2>
      <div className="players">
        {room.players
          .filter((p) => r.participants.includes(p.id))
          .map((p) => (
            <PlayerCard key={p.id} player={p} status={statusIcon[p.status]} />
          ))}
      </div>
      <WaitingFacts />
    </div>
  );
}

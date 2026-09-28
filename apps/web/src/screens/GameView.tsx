import { useCallback, useEffect, useState } from "react";
import { PHASE_MS, recordPhaseMs, timerMs, type RoomSnapshot } from "@dubroom/shared";
import { Button, ConnectionBadge, FloatingReactions, PhaseBar, Timer, useNow } from "@dubroom/ui";
import { game } from "../net/client.ts";
import { selectMe, useGame } from "../net/store.ts";
import { sounds } from "../lib/audio.ts";
import { useT, type MsgKey } from "../lib/i18n.ts";
import { Lobby } from "./Lobby.tsx";
import { Pick } from "./Pick.tsx";
import { Record } from "./Record.tsx";
import { Watch } from "./Watch.tsx";
import { Vote } from "./Vote.tsx";
import { Results } from "./Results.tsx";
import { Final } from "./Final.tsx";

export function GameView() {
  const room = useGame((s) => s.room);
  const conn = useGame((s) => s.conn);
  const reactions = useGame((s) => s.reactions);
  if (!room) return <Connecting />;
  return (
    <div className="page page--game">
      <GameHeader room={room} />
      {conn !== "online" && <ConnectionBanner />}
      <main className="game">
        <PhaseScreen room={room} />
      </main>
      <div className="reactions-layer" aria-hidden>
        <FloatingReactions items={reactions} />
      </div>
    </div>
  );
}

function PhaseScreen({ room }: { room: RoomSnapshot }) {
  if (room.phase !== "lobby" && room.phase !== "final" && !room.round)
    return <div className="spinner" />;
  switch (room.phase) {
    case "lobby":
      return <Lobby room={room} />;
    case "pick":
      return <Pick room={room} />;
    case "record":
      return <Record room={room} />;
    case "watch":
      return <Watch room={room} />;
    case "vote":
      return <Vote room={room} />;
    case "results":
      return <Results room={room} />;
    case "final":
      return <Final room={room} />;
  }
}

function phaseTotalMs(room: RoomSnapshot): number | undefined {
  const relaxed = room.settings.relaxedTimers;
  switch (room.phase) {
    case "pick":
      return timerMs(PHASE_MS.pick, relaxed);
    case "vote":
      return timerMs(PHASE_MS.vote, relaxed);
    case "results":
      return timerMs(PHASE_MS.results, relaxed);
    case "record":
      return room.round?.clip ? recordPhaseMs(room.round.clip.durationMs, relaxed) : undefined;
    default:
      return undefined;
  }
}

function GameHeader({ room }: { room: RoomSnapshot }) {
  const t = useT();
  const offset = useGame((s) => s.serverOffset);
  const conn = useGame((s) => s.conn);
  const rtt = useGame((s) => s.rtt);
  const playAt = useGame((s) => s.playAt);
  const me = useGame(selectMe);
  const r = room.round;
  const vars = { r: r?.index ?? 0, total: room.settings.rounds };
  let title: string;
  if (room.phase === "lobby") title = `DubRoom · ${room.code}`;
  else if (room.phase === "final") title = t("phase.final");
  else if (room.phase === "watch")
    title = t("phase.watch", {
      ...vars,
      i: (playAt?.index ?? 0) + 1,
      n: r?.entries.filter((e) => !e.lost).length ?? 0,
    });
  else title = t(`phase.${room.phase}` as MsgKey, vars);

  // "status is always visible" (§20.1): who we are still waiting for
  const waitingFor =
    r && ["pick", "record", "vote"].includes(room.phase)
      ? room.players
          .filter((p) => {
            if (!p.connected || p.status === "done") return false;
            // in "host picks" mode only the host acts during pick
            if (room.phase === "pick" && room.settings.clipPick === "host") return p.isHost;
            // everyone connected votes (spectators too); pick/record are for participants
            return room.phase === "vote" || r.participants.includes(p.id);
          })
          .map((p) => p.name)
      : [];
  const onTick = useCallback((s: number) => {
    if (s > 0 && s <= 5) sounds.tick();
  }, []);

  return (
    <PhaseBar
      title={title}
      waiting={
        waitingFor.length > 0 && waitingFor.length <= 4
          ? t("wait.for", { names: waitingFor.join(", ") })
          : undefined
      }
      right={
        <div className="row">
          {room.phase === "record" && me && !me.spectator && <span className="rec-dot">● REC</span>}
          <Timer
            endsAt={room.endsAt}
            totalMs={phaseTotalMs(room)}
            serverOffset={offset}
            onTick={onTick}
          />
          <ConnectionBadge
            state={conn === "online" ? "online" : conn === "offline" ? "offline" : "connecting"}
            rttMs={rtt}
          />
          {me?.isHost && room.phase !== "lobby" && room.phase !== "final" && (
            <Button
              size="small"
              variant="ghost"
              onClick={() => game.send({ t: "skipPhase" })}
              title="skip"
            >
              ⏭
            </Button>
          )}
        </div>
      }
    />
  );
}

function ConnectionBanner() {
  const t = useT();
  const conn = useGame((s) => s.conn);
  const deadline = useGame((s) => s.reconnectDeadline);
  const now = useNow(500);
  return (
    <div className="banner banner--warn" role="alert">
      {conn === "offline" ? (
        <>
          {t("conn.lost")}{" "}
          <Button size="small" onClick={() => game.retry()}>
            {t("conn.retry")}
          </Button>
        </>
      ) : (
        t("conn.reconnecting", {
          s: deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 60,
        })
      )}
    </div>
  );
}

function Connecting() {
  const conn = useGame((s) => s.conn);
  return (
    <div className="page page--center" aria-busy="true">
      {conn === "offline" ? <ConnectionBanner /> : <div className="spinner" />}
    </div>
  );
}

/** "Waiting for Lyosha…" + fun facts when a wait is longer than 5 s (§20.6). */
export function WaitingFacts() {
  const t = useT();
  const [i, setI] = useState(0);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const s = setTimeout(() => setShow(true), 5000);
    const r = setInterval(() => setI((x) => x + 1), 7000);
    return () => {
      clearTimeout(s);
      clearInterval(r);
    };
  }, []);
  if (!show) return null;
  return <p className="fact">💡 {t(`facts.${(i % 4) + 1}` as MsgKey)}</p>;
}

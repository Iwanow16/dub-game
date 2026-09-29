import { useState } from "react";
import { AGE_RATINGS, MAX_PLAYERS, type RoomSettings, type RoomSnapshot } from "@dubroom/shared";
import { Button, Modal, PlayerCard, QRCode, RoomCode, useToast } from "@dubroom/ui";
import { game } from "../net/client.ts";
import { selectMe, useGame } from "../net/store.ts";
import { roomUrl } from "../lib/router.ts";
import { unlockAudio } from "../lib/audio.ts";
import { useT } from "../lib/i18n.ts";

export function Lobby({ room }: { room: RoomSnapshot }) {
  const t = useT();
  const toast = useToast();
  const me = useGame(selectMe);
  const [qr, setQr] = useState(false);
  const players = room.players.filter((p) => !p.spectator);
  const spectators = room.players.filter((p) => p.spectator);
  const isHost = Boolean(me?.isHost);
  const canStart = players.filter((p) => p.connected).length >= 2;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(roomUrl(room.code));
      toast({ text: t("lobby.copied"), kind: "success" }, 2000);
    } catch {
      setQr(true);
    }
  };

  return (
    <div className="lobby">
      <section className="lobby__head">
        <RoomCode code={room.code} label={t("home.codeLabel")} />
        <div className="row">
          <Button size="small" onClick={copy}>
            {t("lobby.copy")}
          </Button>
          <Button size="small" onClick={() => setQr(true)}>
            {t("lobby.qr")}
          </Button>
        </div>
      </section>

      <div className="lobby__grid">
        <section>
          <h2>{t("lobby.players", { n: players.length })}</h2>
          <div className="players" role="list">
            {players.map((p) => (
              <div role="listitem" key={p.id}>
                <PlayerCard
                  player={p}
                  me={p.id === me?.id}
                  status={p.connected ? "✓" : "…"}
                  actions={
                    isHost && p.id !== me?.id ? <HostMenu id={p.id} name={p.name} /> : undefined
                  }
                />
              </div>
            ))}
            {Array.from({ length: Math.max(0, MAX_PLAYERS - players.length) }, (_, i) => (
              <div key={`empty${i}`} className="dr-player dr-player--empty" aria-hidden>
                <span className="empty-seat">+</span>
              </div>
            ))}
          </div>
          {spectators.length > 0 && (
            <p className="dr-muted">{t("lobby.spectators", { n: spectators.length })}</p>
          )}
          {me && (
            <Button
              size="small"
              variant="ghost"
              onClick={() => game.send({ t: "becomeSpectator", spectator: !me.spectator })}
              disabled={!me.spectator ? false : players.length >= MAX_PLAYERS}
            >
              {me.spectator ? t("lobby.bePlayer") : t("lobby.beSpectator")}
            </Button>
          )}
          {me?.spectator && <p className="dr-muted">{t("lobby.youAreSpectator")}</p>}
        </section>

        <section className="dr-card">
          <h2>{t("lobby.settings")}</h2>
          <RoomSettingsForm settings={room.settings} editable={isHost} />
        </section>
      </div>

      <div className="lobby__start">
        {isHost ? (
          <>
            <Button
              variant="primary"
              disabled={!canStart}
              onClick={() => {
                void unlockAudio();
                game.send({ t: "start" });
              }}
            >
              {t("lobby.start")}
            </Button>
            {!canStart && <p className="dr-muted">{t("lobby.needTwo")}</p>}
          </>
        ) : (
          <p className="dr-muted">{t("lobby.waitHost")}</p>
        )}
      </div>

      {qr && (
        <Modal title={room.code} onClose={() => setQr(false)}>
          <div className="qr-wrap">
            <QRCode value={roomUrl(room.code)} size={260} />
            <p className="mono">{roomUrl(room.code)}</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

function HostMenu({ id, name }: { id: string; name: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name);
  return (
    <>
      <Button
        size="small"
        variant="ghost"
        aria-label={`${name}: меню`}
        onClick={() => setOpen(true)}
      >
        ⋯
      </Button>
      {open && (
        <Modal title={name} onClose={() => setOpen(false)}>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              game.send({ t: "rename", playerId: id, name: value });
              setOpen(false);
            }}
          >
            <input
              className="dr-input"
              value={value}
              maxLength={20}
              onChange={(e) => setValue(e.target.value)}
            />
            <Button type="submit">{t("lobby.rename")}</Button>
          </form>
          <p />
          <Button
            variant="danger"
            onClick={() => {
              game.send({ t: "kick", playerId: id });
              setOpen(false);
            }}
          >
            {t("lobby.kick")}
          </Button>
        </Modal>
      )}
    </>
  );
}

function RoomSettingsForm({ settings, editable }: { settings: RoomSettings; editable: boolean }) {
  const t = useT();
  const set = (patch: Partial<RoomSettings>) => game.send({ t: "settings", settings: patch });
  return (
    <fieldset className="form-grid" disabled={!editable}>
      <label className="dr-field">
        <span>{t("settings.rounds")}</span>
        <select
          className="dr-input"
          value={settings.rounds}
          onChange={(e) => set({ rounds: Number(e.target.value) as 3 | 5 | 7 })}
        >
          {[3, 5, 7].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="dr-field">
        <span>{t("settings.mode")}</span>
        <select
          className="dr-input"
          value={settings.mode}
          onChange={(e) => set({ mode: e.target.value as RoomSettings["mode"] })}
        >
          <option value="classic">{t("settings.mode.classic")}</option>
          <option value="roles">{t("settings.mode.roles")}</option>
          <option value="improv">{t("settings.mode.improv")}</option>
        </select>
      </label>
      <label className="dr-field">
        <span>{t("settings.rating")}</span>
        <select
          className="dr-input"
          value={settings.maxAgeRating}
          onChange={(e) => set({ maxAgeRating: e.target.value as RoomSettings["maxAgeRating"] })}
        >
          {AGE_RATINGS.map((r) => (
            <option key={r} value={r}>
              ≤ {r}
            </option>
          ))}
        </select>
      </label>
      <label className="dr-field">
        <span>{t("settings.pick")}</span>
        <select
          className="dr-input"
          value={settings.clipPick}
          onChange={(e) => set({ clipPick: e.target.value as RoomSettings["clipPick"] })}
        >
          <option value="vote">{t("settings.pick.vote")}</option>
          <option value="host">{t("settings.pick.host")}</option>
        </select>
      </label>
      <label className="dr-field">
        <span>{t("settings.segment")}</span>
        <select
          className="dr-input"
          value={settings.segment}
          onChange={(e) => set({ segment: e.target.value as RoomSettings["segment"] })}
        >
          <option value="scene">{t("settings.segment.scene")}</option>
          <option value="full">{t("settings.segment.full")}</option>
        </select>
      </label>
      {settings.segment === "full" && (
        <p className="dr-muted small">{t("settings.segment.fullHint")}</p>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={settings.anonymous}
          onChange={(e) => set({ anonymous: e.target.checked })}
        />
        {t("settings.anonymous")}
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.relaxedTimers}
          onChange={(e) => set({ relaxedTimers: e.target.checked })}
        />
        {t("settings.relaxed")}
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.locked}
          onChange={(e) => set({ locked: e.target.checked })}
        />
        {t("settings.locked")}
      </label>
    </fieldset>
  );
}

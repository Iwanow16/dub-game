import { useState } from "react";
import type { RoomSnapshot } from "@dubroom/shared";
import { Button, Modal, useToast } from "@dubroom/ui";
import { useIdentity } from "../lib/identity.ts";
import { useT } from "../lib/i18n.ts";

/** Complaint about the clip or a player (§14) — lands in Clip Studio → «Жалобы». */
export function ReportButton({ room }: { room: RoomSnapshot }) {
  const t = useT();
  const toast = useToast();
  const me = useIdentity((s) => s.playerId);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("clip");
  const [reason, setReason] = useState("");
  const clip = room.round?.clip;
  const others = room.players.filter((p) => p.id !== me);

  const send = async () => {
    const token = await useIdentity.getState().ensureToken();
    const body =
      target === "clip"
        ? { targetType: "clip", targetId: clip?.id ?? "", reason }
        : {
            targetType: "player",
            targetId: `${room.code}:${target}:${others.find((p) => p.id === target)?.name ?? ""}`,
            reason,
          };
    const res = await fetch("/api/reports", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    toast(
      res.ok
        ? { text: t("report.sent"), kind: "success" }
        : { text: t("err.generic"), kind: "error" },
    );
    if (res.ok) {
      setOpen(false);
      setReason("");
    }
  };

  return (
    <>
      <Button size="small" variant="ghost" onClick={() => setOpen(true)}>
        {t("report.button")}
      </Button>
      {open && (
        <Modal title={t("report.title")} onClose={() => setOpen(false)}>
          <div className="form-grid">
            <select
              className="dr-input"
              value={target}
              aria-label={t("report.title")}
              onChange={(e) => setTarget(e.target.value)}
            >
              {clip && <option value="clip">{t("report.clip")}</option>}
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  {t("report.player")}: {p.name}
                </option>
              ))}
            </select>
            <label className="dr-field">
              <span>{t("report.reason")}</span>
              <textarea
                className="dr-input"
                rows={3}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <Button variant="primary" disabled={!reason.trim()} onClick={() => void send()}>
              {t("report.send")}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

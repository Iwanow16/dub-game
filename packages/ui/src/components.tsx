import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import qrcode from "qrcode-generator";
import type { PlayerPublic } from "@dubroom/shared";
import { Avatar } from "./Avatar.tsx";

/* ---------- Button ---------- */

export function Button({
  variant = "secondary",
  size,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "small";
}) {
  const cls = [
    "dr-btn",
    variant !== "secondary" ? `dr-btn--${variant}` : "",
    size ? `dr-btn--${size}` : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return <button type="button" className={cls} {...rest} />;
}

/* ---------- RoomCode ---------- */

export function RoomCode({ code, label = "Комната" }: { code: string; label?: string }) {
  return (
    <span>
      <span className="dr-muted">{label} </span>
      <span className="dr-room-code" aria-label={code.split("").join(" ")}>
        {code}
      </span>
    </span>
  );
}

/* ---------- PlayerCard ---------- */

export function PlayerCard({
  player,
  me,
  status,
  mouthOpen,
  actions,
}: {
  player: Pick<PlayerPublic, "name" | "avatar" | "isHost" | "connected" | "status" | "progress">;
  me?: boolean;
  status?: ReactNode;
  mouthOpen?: number;
  actions?: ReactNode;
}) {
  return (
    <div
      className={`dr-player ${me ? "dr-player--me" : ""} ${player.connected ? "" : "dr-player--offline"}`}
    >
      {player.isHost && (
        <span className="dr-player__crown" role="img" aria-label="хост">
          👑
        </span>
      )}
      <Avatar spec={player.avatar} size={64} mouthOpen={mouthOpen} title={player.name} />
      <span className="dr-player__name" title={player.name}>
        {player.name}
      </span>
      <span className="dr-player__status">{status}</span>
      {player.status === "uploading" && (
        <span className="dr-player__progress" aria-hidden>
          <i style={{ width: `${Math.round(player.progress * 100)}%` }} />
        </span>
      )}
      {actions}
    </div>
  );
}

/* ---------- Timer (ring) ---------- */

export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function Timer({
  endsAt,
  totalMs,
  serverOffset = 0,
  size = 48,
  onTick,
}: {
  endsAt: number | null;
  totalMs?: number;
  /** serverNow − clientNow */
  serverOffset?: number;
  size?: number;
  onTick?: (secondsLeft: number) => void;
}) {
  const now = useNow(200);
  const left = endsAt == null ? null : Math.max(0, endsAt - (now + serverOffset));
  const secs = left == null ? null : Math.ceil(left / 1000);
  const lastTick = useRef<number | null>(null);
  useEffect(() => {
    if (secs != null && secs !== lastTick.current) {
      lastTick.current = secs;
      onTick?.(secs);
    }
  }, [secs, onTick]);
  if (left == null) return null;
  const frac = totalMs ? Math.min(1, left / totalMs) : 1;
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const mm = String(Math.floor(secs! / 60)).padStart(2, "0");
  const ss = String(secs! % 60).padStart(2, "0");
  return (
    <span
      className={`dr-timer ${secs! <= 5 ? "dr-timer--urgent" : ""}`}
      role="timer"
      aria-label={`осталось ${secs} секунд`}
    >
      <svg width={size} height={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="var(--surface-2)"
          strokeWidth="4"
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={secs! <= 5 ? "var(--rec)" : "var(--accent)"}
          strokeWidth="4"
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          strokeLinecap="round"
        />
      </svg>
      <span style={{ fontSize: size > 56 ? "1rem" : "0.7rem" }}>
        {secs! >= 60 ? `${mm}:${ss}` : secs}
      </span>
    </span>
  );
}

/* ---------- PhaseBar ---------- */

export function PhaseBar({
  title,
  waiting,
  right,
  children,
}: {
  title: ReactNode;
  waiting?: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="dr-phasebar">
      <div className="dr-phasebar__title">
        <div aria-live="polite">{title}</div>
        {waiting && <div className="dr-phasebar__waiting">{waiting}</div>}
      </div>
      {children}
      {right}
    </header>
  );
}

/* ---------- LevelMeter ---------- */

export function LevelMeter({ level, bars = 7 }: { level: number; bars?: number }) {
  return (
    <span
      className="dr-meter"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(level * 100)}
      aria-label="уровень микрофона"
    >
      {Array.from({ length: bars }, (_, i) => {
        const on = level * bars > i;
        const peak = Math.abs(i - (bars - 1) / 2);
        const h = 28 - peak * (20 / bars) * 2;
        return (
          <i
            key={i}
            className={on ? (i >= bars - 1 ? "hot" : "on") : ""}
            style={{ height: Math.max(6, h) }}
          />
        );
      })}
    </span>
  );
}

/* ---------- LineTimeline ---------- */

export interface TimelineSegment {
  startMs: number;
  endMs: number;
  color: string;
  mine?: boolean;
  label?: string;
  pattern?: number;
}

export function LineTimeline({
  durationMs,
  segments,
  positionMs,
  onSeek,
}: {
  durationMs: number;
  segments: TimelineSegment[];
  positionMs?: number;
  onSeek?: (ms: number) => void;
}) {
  const pct = (ms: number) => `${(Math.max(0, Math.min(durationMs, ms)) / durationMs) * 100}%`;
  return (
    <div
      className="dr-timeline"
      role={onSeek ? "slider" : "img"}
      aria-label="таймлайн реплик"
      aria-valuemin={onSeek ? 0 : undefined}
      aria-valuemax={onSeek ? durationMs : undefined}
      aria-valuenow={onSeek ? positionMs : undefined}
      onClick={
        onSeek
          ? (e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              onSeek(((e.clientX - rect.left) / rect.width) * durationMs);
            }
          : undefined
      }
    >
      {segments.map((s, i) => (
        <span
          key={i}
          title={s.label}
          className={`dr-timeline__seg ${s.mine ? "dr-timeline__seg--mine" : ""} ${s.pattern ? `dr-timeline__seg--pattern-${s.pattern}` : ""}`}
          style={{
            left: pct(s.startMs),
            width: `calc(${pct(s.endMs)} - ${pct(s.startMs)})`,
            background: s.color,
          }}
        />
      ))}
      {positionMs != null && (
        <span className="dr-timeline__head" style={{ left: pct(positionMs) }} />
      )}
    </div>
  );
}

/* ---------- Scoreboard ---------- */

export function Scoreboard({
  rows,
}: {
  rows: {
    id: string;
    name: string;
    avatar: PlayerPublic["avatar"];
    score: number;
    delta?: number;
  }[];
}) {
  const max = Math.max(1, ...rows.map((r) => r.score));
  return (
    <ol className="dr-score">
      {rows.map((r, i) => (
        <li key={r.id}>
          <span className="dr-muted">{i + 1}.</span>
          <Avatar spec={r.avatar} size={40} title={r.name} />
          <span className="dr-player__name">{r.name}</span>
          <span style={{ display: "block" }}>
            <span
              className="dr-score__bar"
              style={{ display: "block", width: `${Math.max(2, (r.score / max) * 100)}%` }}
            />
          </span>
          <span className="dr-score__pts">
            {r.score}
            {r.delta ? <span className="dr-score__delta">+{r.delta}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/* ---------- ReactionBar + floating reactions ---------- */

export function ReactionBar({
  emojis,
  onReact,
}: {
  emojis: readonly string[];
  onReact: (e: string) => void;
}) {
  return (
    <div className="dr-reactions" role="group" aria-label="реакции">
      {emojis.map((e) => (
        <button key={e} type="button" onClick={() => onReact(e)} aria-label={`реакция ${e}`}>
          {e}
        </button>
      ))}
    </div>
  );
}

export function FloatingReactions({
  items,
}: {
  items: { id: number; emoji: string; x: number }[];
}) {
  return (
    <>
      {items.map((r) => (
        <span key={r.id} className="dr-float" style={{ left: `${r.x}%` }} aria-hidden>
          {r.emoji}
        </span>
      ))}
    </>
  );
}

/* ---------- Toasts ---------- */

type ToastKind = "info" | "error" | "success";
interface ToastItem {
  id: number;
  text: ReactNode;
  kind: ToastKind;
  action?: { label: string; onClick: () => void };
}
const ToastCtx = createContext<(t: Omit<ToastItem, "id">, ms?: number) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const push = useCallback((t: Omit<ToastItem, "id">, ms = 5000) => {
    const id = nextId.current++;
    setItems((xs) => [...xs.slice(-3), { ...t, id }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), ms);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="dr-toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`dr-toast dr-toast--${t.kind}`}>
            <span>{t.text}</span>
            {t.action && (
              <Button size="small" onClick={t.action.onClick}>
                {t.action.label}
              </Button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/* ---------- Modal ---------- */

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="dr-modal-backdrop" onClick={onClose}>
      <div
        className="dr-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 8 }}
        >
          <h2>{title}</h2>
          <Button variant="ghost" size="small" onClick={onClose} aria-label="закрыть">
            ✕
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ---------- QRCode ---------- */

export function QRCode({ value, size = 220 }: { value: string; size?: number }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }, [value]);
  return (
    <div
      className="dr-qr"
      style={{ width: size }}
      role="img"
      aria-label={`QR-код: ${value}`}
      // generated locally from our own URL, no user HTML
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/* ---------- ConnectionBadge ---------- */

export function ConnectionBadge({
  state,
  rttMs,
}: {
  state: "online" | "connecting" | "offline";
  rttMs?: number | null;
}) {
  const cls = state === "online" ? "" : state === "connecting" ? "dr-badge--warn" : "dr-badge--bad";
  const text =
    state === "online"
      ? rttMs != null
        ? `${Math.round(rttMs)} мс`
        : "онлайн"
      : state === "connecting"
        ? "подключение…"
        : "нет связи";
  return (
    <span className={`dr-badge ${cls}`} role="status">
      <span className="dr-badge__dot" />
      {text}
    </span>
  );
}

/* ---------- SyncSlider ---------- */

export function SyncSlider({
  value,
  onChange,
  min = -200,
  max = 200,
  label = "Синхронизация",
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  label?: string;
}) {
  return (
    <label className="dr-field">
      <span>
        {label}: {value > 0 ? "+" : ""}
        {value} мс
      </span>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className="dr-muted">{min}</span>
        <input
          className="dr-slider"
          type="range"
          min={min}
          max={max}
          step={10}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="dr-muted">+{max}</span>
      </div>
    </label>
  );
}

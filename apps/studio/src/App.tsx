import { useEffect, useState } from "react";
import { Button, ToastProvider } from "@dubroom/ui";
import { api, getKey, setKey } from "./api.ts";
import { Library } from "./Library.tsx";
import { Editor } from "./Editor.tsx";
import { NewClip } from "./NewClip.tsx";
import { Reports } from "./Reports.tsx";

type View =
  { name: "library" } | { name: "new" } | { name: "draft"; id: string } | { name: "reports" };

function parseHash(): View {
  const h = location.hash.replace(/^#\/?/, "");
  if (h === "new") return { name: "new" };
  if (h === "reports") return { name: "reports" };
  const m = /^draft\/([\w-]+)$/.exec(h);
  if (m) return { name: "draft", id: m[1]! };
  return { name: "library" };
}

export function go(hash: string) {
  location.hash = hash;
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [view, setView] = useState<View>(parseHash);

  useEffect(() => {
    const on = () => setView(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    if (!getKey()) return setAuthed(false);
    api.me().then(
      () => setAuthed(true),
      () => setAuthed(false),
    );
  }, []);

  if (authed === null) return null;
  if (!authed) return <Login onOk={() => setAuthed(true)} />;

  return (
    <ToastProvider>
      <div className="studio">
        <header className="studio__top">
          <a href="#/" className="studio__logo">
            🎬 Clip Studio
          </a>
          <nav className="row">
            <a
              href="#/"
              className={`dr-btn dr-btn--small ${view.name === "library" ? "" : "dr-btn--ghost"}`}
            >
              Библиотека
            </a>
            <a
              href="#/reports"
              className={`dr-btn dr-btn--small ${view.name === "reports" ? "" : "dr-btn--ghost"}`}
            >
              Жалобы
            </a>
            <a href="#/new" className="dr-btn dr-btn--small dr-btn--primary">
              + Новый клип
            </a>
            <a
              href="/help/author.html"
              target="_blank"
              rel="noreferrer"
              className="dr-btn dr-btn--small dr-btn--ghost"
            >
              Справка
            </a>
            <Button
              size="small"
              variant="ghost"
              onClick={() => {
                setKey("");
                setAuthed(false);
              }}
            >
              Выйти
            </Button>
          </nav>
        </header>
        {view.name === "library" && <Library />}
        {view.name === "new" && <NewClip />}
        {view.name === "draft" && <Editor key={view.id} draftId={view.id} />}
        {view.name === "reports" && <Reports />}
      </div>
    </ToastProvider>
  );
}

function Login({ onOk }: { onOk: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  return (
    <div className="login">
      <form
        className="dr-card login__card"
        onSubmit={async (e) => {
          e.preventDefault();
          setKey(value.trim());
          try {
            await api.me();
            onOk();
          } catch {
            setKey("");
            setError(true);
          }
        }}
      >
        <h1>Clip Studio</h1>
        <p className="dr-muted">Инструмент авторов DubRoom. Введите ключ доступа (STUDIO_KEY).</p>
        <input
          className="dr-input"
          type="password"
          autoFocus
          value={value}
          aria-label="Ключ доступа"
          onChange={(e) => {
            setValue(e.target.value);
            setError(false);
          }}
        />
        {error && (
          <p className="error-text" role="alert">
            Ключ не подошёл
          </p>
        )}
        <Button type="submit" variant="primary">
          Войти
        </Button>
      </form>
    </div>
  );
}

import { useEffect } from "react";
import { normalizeRoomCode } from "@dubroom/shared";
import { ToastProvider } from "@dubroom/ui";
import { useRoute } from "./lib/router.ts";
import { applyVisualPrefs, usePrefs } from "./lib/prefs.ts";
import { useLang } from "./lib/i18n.ts";
import { Home } from "./screens/Home.tsx";
import { Room } from "./screens/Room.tsx";
import { Practice } from "./screens/Practice.tsx";
import { NotFound } from "./screens/NotFound.tsx";

export function App() {
  const path = useRoute((s) => s.path);
  const lang = useLang((s) => s.lang);
  const subtitleScale = usePrefs((s) => s.subtitleScale);
  const lightTheme = usePrefs((s) => s.lightTheme);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  useEffect(() => applyVisualPrefs({ subtitleScale, lightTheme }), [subtitleScale, lightTheme]);

  return <ToastProvider>{route(path)}</ToastProvider>;
}

function route(path: string) {
  if (path === "/" || path === "") return <Home />;
  if (path === "/try") return <Practice />;
  const m = /^\/r\/([^/]+)\/?$/.exec(path);
  if (m) {
    const code = normalizeRoomCode(decodeURIComponent(m[1]!));
    return code ? <Room key={code} code={code} /> : <NotFound />;
  }
  return <NotFound />;
}

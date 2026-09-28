import { create } from "zustand";

/** Tiny history router: "/", "/r/:code", "/try". */
export const useRoute = create<{ path: string }>(() => ({ path: location.pathname }));

window.addEventListener("popstate", () => useRoute.setState({ path: location.pathname }));

export function navigate(path: string, replace = false) {
  if (path === location.pathname) return;
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  useRoute.setState({ path });
  window.scrollTo(0, 0);
}

export function roomUrl(code: string) {
  return `${location.origin}/r/${code}`;
}

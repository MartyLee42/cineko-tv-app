// Hash routing (#/movie/603): works on GitHub Pages without a 404 fallback.
// A new page opens at the top; Back/Forward restore the previous scroll.
import { useSyncExternalStore } from "react";

export interface Route {
  parts: string[];
  query: URLSearchParams;
  hash: string;
}

let pushed = false;
const scrolls = new Map<string, number>();
let current = location.hash || "#/";

function parse(hash: string): Route {
  const h = hash.replace(/^#/, "") || "/";
  const [path, qs = ""] = h.split("?");
  return { parts: path.split("/").filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(qs), hash: hash || "#/" };
}

let route = parse(current);
const listeners = new Set<() => void>();

window.addEventListener("hashchange", () => {
  scrolls.set(current, window.scrollY);
  current = location.hash || "#/";
  route = parse(current);
  const fresh = pushed;
  pushed = false;
  listeners.forEach((l) => l());
  const y = fresh ? 0 : (scrolls.get(current) ?? 0);
  // After React has rendered the new page.
  requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, y)));
});

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => route,
  );
}

export function navigate(to: string, replace = false): void {
  const hash = to.startsWith("#") ? to : "#" + to;
  if (hash === location.hash) return;
  pushed = true;
  if (replace) location.replace(hash);
  else location.hash = hash;
}

let navigatedInApp = false;
window.addEventListener("hashchange", () => (navigatedInApp = true));

/** Back inside the app; a page opened directly (shared link) goes to `fallback`. */
export function goBack(fallback = "/"): void {
  if (navigatedInApp) history.back();
  else navigate(fallback, true);
}

export const titleHref = (type: string, id: number) => `#/${type}/${id}`;
export const playHref = (type: string, id: number, season?: number, episode?: number, fromStart?: boolean) =>
  `#/play/${type}/${id}${type === "tv" && season != null ? `/${season}/${episode}` : ""}${fromStart ? "?from=0" : ""}`;

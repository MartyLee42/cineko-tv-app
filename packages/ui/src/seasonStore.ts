// Tiny shared stores of the season layer: the mascot's hat (set by the
// live layer, read by every <Mascot>) and the 10-second Settings preview.
import { useEffect, useState, useSyncExternalStore } from "react";
import { seasonState, type SeasonId, type SeasonState } from "./seasons";

export type MascotHatId = "santa" | "witch" | null;

function store<T>(initial: T) {
  let value = initial;
  const ls = new Set<() => void>();
  return {
    get: () => value,
    set(v: T) {
      if (v === value) return;
      value = v;
      ls.forEach((l) => l());
    },
    subscribe(l: () => void) {
      ls.add(l);
      return () => void ls.delete(l);
    },
  };
}

const hatStore = store<MascotHatId>(null);
export const setSeasonHat = (h: MascotHatId) => hatStore.set(h);
export function useSeasonHat(): MascotHatId {
  return useSyncExternalStore(hatStore.subscribe, hatStore.get, hatStore.get);
}

/** A preview of a season started from Settings (shown for `PREVIEW_MS`). */
export const PREVIEW_MS = 10_000;
const previewStore = store<SeasonId | null>(null);
let previewTimer: ReturnType<typeof setTimeout> | undefined;
export function startSeasonPreview(id: SeasonId, ms = PREVIEW_MS) {
  clearTimeout(previewTimer);
  previewStore.set(null); // restart the layer (fresh particles) when switching
  previewStore.set(id);
  previewTimer = setTimeout(() => previewStore.set(null), ms);
}
export function stopSeasonPreview() {
  clearTimeout(previewTimer);
  previewStore.set(null);
}
export function useSeasonPreview(): SeasonId | null {
  return useSyncExternalStore(previewStore.subscribe, previewStore.get, previewStore.get);
}

// ---------------------------------------------------------------- environment hooks

/** True while the page is hidden (another tab, TV app in background). */
export function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden === true);
  useEffect(() => {
    const on = () => setHidden(document.hidden === true);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return hidden;
}

/** prefers-reduced-motion: reduce (live). */
export function useReducedMotion(): boolean {
  const q = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const [on, setOn] = useState(() => !!q?.matches);
  useEffect(() => {
    if (!q) return;
    const f = () => setOn(q.matches);
    // Old engines only have addListener.
    if (typeof q.addEventListener === "function") q.addEventListener("change", f);
    else q.addListener(f);
    return () => {
      if (typeof q.removeEventListener === "function") q.removeEventListener("change", f);
      else q.removeListener(f);
    };
  }, [q]);
  return on;
}

/** Any <video> on the page playing. Media events don't bubble, so listen in the capture phase. */
function anyVideoPlaying(): boolean {
  const vs = document.getElementsByTagName("video");
  for (let i = 0; i < vs.length; i++) {
    const v = vs[i]!;
    if (!v.paused && !v.ended) return true;
  }
  return false;
}

export function useVideoPlaying(): boolean {
  const [playing, setPlaying] = useState(() => typeof document !== "undefined" && anyVideoPlaying());
  useEffect(() => {
    const on = () => setPlaying(anyVideoPlaying());
    const evs = ["play", "playing", "pause", "ended", "emptied"];
    evs.forEach((e) => document.addEventListener(e, on, true));
    return () => evs.forEach((e) => document.removeEventListener(e, on, true));
  }, []);
  // A playing video removed from the page fires no event: re-check now and then.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setPlaying(anyVideoPlaying()), 2000);
    return () => clearInterval(id);
  }, [playing]);
  return playing;
}

/** Today's season state (Moscow), re-checked every 5 minutes (TVs run for days). */
export function useTodaySeasonState(): SeasonState | null {
  const [st, setSt] = useState(() => seasonState(new Date()));
  useEffect(() => {
    const id = setInterval(() => {
      const next = seasonState(new Date());
      setSt((cur) => (cur && next && cur.id === next.id && cur.daysToMain === next.daysToMain && cur.main === next.main ? cur : next));
    }, 5 * 60_000);
    return () => clearInterval(id);
  }, []);
  return st;
}

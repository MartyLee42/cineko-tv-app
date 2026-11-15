// «Во всю ширину экрана» (this browser; off by default): on large screens the
// app fills the window instead of a centred ~1150 px column, and poster grids
// add columns instead of growing the posters. Marks <html> with `mt-wide`
// (index.css) so every grid follows without its own state.
import { useSyncExternalStore } from "react";

const KEY = "martytv.wide_layout";
const CLASS = "mt-wide";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let on = read();

function apply() {
  if (typeof document !== "undefined") document.documentElement.classList.toggle(CLASS, on);
}
apply();

export const wideLayout = {
  get: (): boolean => on,
  set(next: boolean) {
    on = next;
    try {
      localStorage.setItem(KEY, next ? "1" : "0");
    } catch {
      /* private mode: this visit only */
    }
    apply();
    for (const l of listeners) l();
  },
};

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Whether the app spans the whole window here (re-renders when Settings flips it). */
export function useWideLayout(): boolean {
  return useSyncExternalStore(subscribe, wideLayout.get, wideLayout.get);
}

/** The page column: centred and capped, or the whole window (a little more side room). */
export function columnClass(wide: boolean): string {
  return wide ? "max-w-none px-4 md:px-8" : "max-w-6xl px-4";
}

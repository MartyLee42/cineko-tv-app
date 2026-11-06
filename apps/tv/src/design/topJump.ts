// "Fast way up": Back / Channel▲ inside long content jumps to the top first
// (Home → its first row, other screens → the menu / tab bar), and screens
// report whether they are scrolled (for the one-time «▲ К вкладкам» hint).
import { useEffect, useRef, useSyncExternalStore } from "react";

type ToTop = (toMenu: boolean) => boolean;
const handlers = new Set<{ current: ToTop }>();

/**
 * A screen's "go to your top" action. Return true when it moved focus itself
 * (Home → first row); false to let the shell focus the menu (after the
 * screen reset its scroll). `toMenu` (Channel▲): only reset, never focus.
 */
export function useToTop(fn: ToTop) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    const h = ref;
    handlers.add(h);
    return () => void handlers.delete(h);
  }, []);
}

/** Runs the mounted screen's handler; true if it handled focus. */
export function runToTop(toMenu = false): boolean {
  let handled = false;
  handlers.forEach((h) => {
    if (h.current(toMenu)) handled = true;
  });
  return handled;
}

/** The shell's Back interceptor (set while the catalog shows). */
let backFirst: (() => boolean) | null = null;
export function setBackFirst(fn: (() => boolean) | null) {
  backFirst = fn;
}
/** App's Back: true when the shell consumed it (jumped to the top). */
export function runBackFirst(): boolean {
  return backFirst ? backFirst() : false;
}

// ---- scrolled state (hint)
let deep = false;
const listeners = new Set<() => void>();
export function setDeep(v: boolean) {
  if (v === deep) return;
  deep = v;
  listeners.forEach((l) => l());
}
export function useDeep(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => deep,
  );
}
/** Reports this screen's scrolled state; resets when it unmounts. */
export function useReportDeep(v: boolean) {
  useEffect(() => setDeep(v), [v]);
  useEffect(() => () => setDeep(false), []);
}

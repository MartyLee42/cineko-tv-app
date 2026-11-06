// The remote's Back on TV hosts: Media Station X (Android link window, Tizen
// app), Android WebView launchers, webOS (its runtime calls history.back()
// on Back by default). There the host runs its own Back as well — WebView
// goBack(), history.back(), or closing the window when the page has no
// history — whether or not the page also gets (and consumes) a keydown for
// it. Cineko keeps all its navigation in memory, so the page had no history
// of its own: a host Back left /tv/ and MSX re-opened it (a full reload,
// back on Home), on the TX3 and on a Samsung alike.
//
// A same-document history entry absorbs the native Back: it arrives here as
// a `popstate`, the entry is put back, and the press becomes one in-app Back
// (a synthetic `GoBack` keydown through the usual handlers) — unless the
// keydown for the same press was already handled. Pure helpers + a small
// installer; App's exit path (platform.exitApp) releases it.
import { isBackKey } from "../platform";

/** One press may arrive as a keydown and a popstate; within this window they count once. */
export const BACK_DEDUPE_MS = 700;

/** A popstate right after a real Back keydown is the same press (already handled). */
export function popIsNewPress(now: number, lastKeyAt: number): boolean {
  return now - lastKeyAt > BACK_DEDUPE_MS;
}

/** A real Back keydown right after a popstate we turned into Back is the same press. */
export function keyIsEcho(now: number, lastSynthAt: number): boolean {
  return now - lastSynthAt < BACK_DEDUPE_MS;
}

/** Where the trap is needed: every TV host (Android/MSX, Tizen, webOS) — not a desktop browser, where Back is the user's own browser button. */
export function needsBackTrap(platform: string): boolean {
  return platform !== "browser";
}

const STATE = { martytv: "back-trap" };

let trap: { baseLength: number; leaving: boolean } | null = null;

/** Installs the trap (once). Call before any other keydown listener is registered. */
export function installBackTrap(now: () => number = Date.now): void {
  if (trap || typeof window === "undefined" || typeof history === "undefined") return;
  const t = { baseLength: history.length, leaving: false };
  try {
    history.pushState(STATE, "");
  } catch {
    return;
  }
  trap = t;
  let lastKeyAt = -Infinity;
  let lastSynthAt = -Infinity;
  /** Our own GoBack keydowns (everything else is the remote's). */
  const ours = new WeakSet<Event>();
  window.addEventListener(
    "keydown",
    (e) => {
      if (ours.has(e) || !isBackKey(e)) return;
      const at = now();
      if (keyIsEcho(at, lastSynthAt)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      lastKeyAt = at;
    },
    true,
  );
  window.addEventListener("popstate", () => {
    if (t.leaving) return;
    try {
      history.pushState(STATE, "");
    } catch {
      // keep going: this press is still handled
    }
    const at = now();
    if (!popIsNewPress(at, lastKeyAt)) return;
    lastSynthAt = at;
    const target = document.activeElement ?? document.body;
    const ev = new KeyboardEvent("keydown", { key: "GoBack", bubbles: true, cancelable: true });
    ours.add(ev);
    target.dispatchEvent(ev);
  });
}

/**
 * Leaving the app on purpose (the second Back on Home): drop the trap entry
 * and go to whatever opened Cineko. False when no trap is installed.
 */
export function leaveThroughTrap(): boolean {
  if (!trap) return false;
  trap.leaving = true;
  if (trap.baseLength > 1) history.go(-2);
  else {
    history.back();
    window.close();
  }
  return true;
}

/** Tests. */
export function backTrapInstalled(): boolean {
  return trap !== null;
}

// «Матрица» extras shared by the TV app and the PWA: the red/blue pill
// choice the first time someone picks the design (once per device), and the
// typed «Wake up, …» mood line. Pure helpers + a tiny store; no React here
// except the hook.
import { useSyncExternalStore } from "react";
import type { DesignSetting } from "./designs";

const SEEN_KEY = "martytv.matrixPill";

/** Ask before switching to Matrix: only the first time on this device, and only when coming from another design. */
export function shouldAskPill(next: DesignSetting, prev: DesignSetting, seen: boolean): boolean {
  return next === "matrix" && prev !== "matrix" && !seen;
}

export function matrixPillSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true; // no storage: never nag
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* private mode */
  }
}

/** A pending choice: the design to go back to (blue) and how. */
export interface PillRequest {
  previous: DesignSetting;
  revert: () => void;
}

let pending: PillRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Shows the pill dialog (the caller has already applied Matrix). */
export function requestPill(r: PillRequest) {
  pending = r;
  emit();
}

/** Blue: back to the previous design. Red: stay. Either way it's not asked again here. */
export function resolvePill(choice: "red" | "blue") {
  const r = pending;
  pending = null;
  markSeen();
  if (choice === "blue") r?.revert();
  emit();
}

export function usePillRequest(): PillRequest | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => pending,
    () => pending,
  );
}

/** Test hook. */
export function resetPillForTests() {
  pending = null;
  emit();
}

/**
 * Matrix's Home mood line: «Wake up, {name}…» plus the day's tail, picked
 * from `tails` stably for the day (the mood line's daily rhythm).
 */
export function wakeUpTail<T>(tails: readonly T[], d: Date): T {
  const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
  return tails[day % tails.length]!;
}

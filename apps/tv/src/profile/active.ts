// The profile the TV is signed in with (set by App). A tiny external store so
// non-React code (player, queries) can read it synchronously.
import { useSyncExternalStore } from "react";

let activeId: string | null = null;
/** The value subscribers were last told about. */
let notified: string | null = null;
const listeners = new Set<() => void>();

export const activeProfile = {
  get: () => activeId,
  set(id: string | null) {
    activeId = id;
    if (id === notified) return;
    notified = id;
    listeners.forEach((l) => l());
  },
  /**
   * Sets the id during the parent's render, before children read it (no
   * notification: nobody has rendered with the old value yet in this pass).
   * The App also calls set() in an effect, which notifies if needed.
   */
  prime(id: string | null) {
    activeId = id;
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useActiveProfileId(): string | null {
  return useSyncExternalStore(activeProfile.subscribe, activeProfile.get);
}


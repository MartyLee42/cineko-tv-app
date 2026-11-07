// The open quick-actions popup and the focused card ☰ / Info would open.
import { createContext, useContext } from "react";
import type { MediaSummary } from "@martytv/contracts";

export interface QuickTarget {
  item: MediaSummary;
  /** «Подробнее» (the card's normal OK). */
  onOpen?: () => void;
  /** «Не интересно» handled by the row (e.g. «Для вас» moves focus and asks «Почему?»); default: the generic dismissal. */
  onDismiss?: () => void;
  /** Row id for the dismissal's feedback. */
  rowId?: string;
}

type Listener = () => void;
let open: QuickTarget | null = null;
let focused: { key: string; get: () => QuickTarget | null } | null = null;
const listeners = new Set<Listener>();

export const quickMenu = {
  get: () => open,
  open(t: QuickTarget) {
    open = t;
    listeners.forEach((l) => l());
  },
  close() {
    if (!open) return;
    open = null;
    listeners.forEach((l) => l());
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  /** A quick-capable card got focus (☰ / Info opens it while it keeps focus). */
  focus(key: string, get: () => QuickTarget | null) {
    focused = { key, get };
  },
  focusedTarget(currentKey: string | undefined): QuickTarget | null {
    return focused && currentKey && focused.key === currentKey ? focused.get() : null;
  },
};

/** Inside a slot with quick actions (the focused card shows the «⋯» hint). */
export const QuickHintContext = createContext(false);
export const useQuickHint = () => useContext(QuickHintContext);

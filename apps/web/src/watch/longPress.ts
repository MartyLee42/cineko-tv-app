// Touch long-press on a poster card (opens its quick actions): 500 ms without
// moving the finger more than a few px (a scroll or swipe cancels it). The
// tap that ends a long press must not also follow the card's link.
import { useEffect, useRef } from "react";

export const LONG_PRESS_MS = 500;
export const MOVE_TOLERANCE_PX = 10;

/** Whether the finger moved enough (scroll / swipe) to cancel a long press. */
export function movedTooFar(start: { x: number; y: number }, now: { x: number; y: number }, tol = MOVE_TOLERANCE_PX): boolean {
  return Math.abs(now.x - start.x) > tol || Math.abs(now.y - start.y) > tol;
}

/** Handlers for the card: `onLong` after a held touch or on the context menu (right click / Android long press). */
export function useLongPress(onLong: (el: HTMLElement) => void, enabled = true) {
  const st = useRef<{ timer?: ReturnType<typeof setTimeout>; start: { x: number; y: number } | null; fired: boolean }>({ start: null, fired: false });
  useEffect(() => () => clearTimeout(st.current.timer), []);
  if (!enabled) return {};
  // React events bubble out of portals (the quick sheet): only the card's own DOM counts.
  const inside = (e: React.SyntheticEvent) => (e.currentTarget as Node).contains(e.target as Node);
  const cancel = () => {
    clearTimeout(st.current.timer);
    st.current.start = null;
  };
  return {
    onTouchStart: (e: React.TouchEvent) => {
      if (!inside(e)) return;
      const t = e.touches[0];
      if (!t || e.touches.length > 1) return cancel();
      st.current.fired = false;
      st.current.start = { x: t.clientX, y: t.clientY };
      const el = e.currentTarget as HTMLElement;
      clearTimeout(st.current.timer);
      st.current.timer = setTimeout(() => {
        st.current.fired = true;
        st.current.start = null;
        onLong(el);
      }, LONG_PRESS_MS);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (st.current.start && t && movedTooFar(st.current.start, { x: t.clientX, y: t.clientY })) cancel();
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
    onContextMenu: (e: React.MouseEvent) => {
      if (!inside(e)) return;
      e.preventDefault();
      // Android fires it on a held touch (a click may follow); a right click has no click after it.
      const touching = st.current.start !== null || st.current.fired;
      cancel();
      if (!st.current.fired) onLong(e.currentTarget as HTMLElement);
      st.current.fired = touching;
    },
    // The click that ends a long press only opened the menu.
    onClickCapture: (e: React.MouseEvent) => {
      if (!st.current.fired) return;
      st.current.fired = false;
      if (!inside(e)) return;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

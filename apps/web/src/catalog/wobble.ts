// «Живые постеры» (ProfileSettings.poster_wobble) on the web: a poster card
// tilts slightly toward the mouse pointer and springs back when it leaves.
// Fine pointers only (nothing on touch), off with reduced motion. The
// transform is written straight to the element once per animation frame —
// no React state, no re-render while the mouse moves.
import { useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { useSettings } from "../watch/queries";

/** The largest tilt, degrees. */
export const MAX_TILT = 6;

/** Tilt angles for a pointer at (x, y) inside a w×h box: the side under the pointer dips away. */
export function tiltFor(x: number, y: number, w: number, h: number, max = MAX_TILT): { rx: number; ry: number } {
  if (!(w > 0) || !(h > 0)) return { rx: 0, ry: 0 };
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const nx = clamp(x / w) - 0.5;
  const ny = clamp(y / h) - 0.5;
  const round = (v: number) => Math.round(v * 100) / 100 + 0; // + 0: no -0
  return { rx: round(-ny * 2 * max), ry: round(nx * 2 * max) };
}

export function tiltTransform(t: { rx: number; ry: number }): string {
  return `perspective(700px) translateY(-2px) rotateX(${t.rx}deg) rotateY(${t.ry}deg) scale(1.02)`;
}

/** Follow-the-pointer and spring-back transitions. */
const FOLLOW = "transform 120ms ease-out";
const SPRING = "transform 520ms cubic-bezier(.34,1.56,.64,1)";

function mediaStore(query: string) {
  const mq = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null);
  return {
    subscribe(l: () => void) {
      const q = mq();
      q?.addEventListener?.("change", l);
      return () => q?.removeEventListener?.("change", l);
    },
    get: () => !!mq()?.matches,
  };
}
const fine = mediaStore("(hover: hover) and (pointer: fine)");
const reduced = mediaStore("(prefers-reduced-motion: reduce)");

/** The profile wants it, the pointer is a mouse/trackpad and motion isn't reduced. */
export function useWobbleEnabled(): boolean {
  const on = useSettings().poster_wobble !== false;
  const isFine = useSyncExternalStore(fine.subscribe, fine.get, () => false);
  const isReduced = useSyncExternalStore(reduced.subscribe, reduced.get, () => true);
  return on && isFine && !isReduced;
}

const pending = new WeakMap<HTMLElement, { x: number; y: number; raf: number }>();

function onMove(e: ReactPointerEvent<HTMLElement>) {
  if (e.pointerType !== "mouse") return;
  const el = e.currentTarget;
  const p = pending.get(el);
  if (p) {
    p.x = e.clientX;
    p.y = e.clientY;
    return;
  }
  const next = { x: e.clientX, y: e.clientY, raf: 0 };
  next.raf = requestAnimationFrame(() => {
    pending.delete(el);
    const r = el.getBoundingClientRect();
    el.style.transition = FOLLOW;
    el.style.transform = tiltTransform(tiltFor(next.x - r.left, next.y - r.top, r.width, r.height));
  });
  pending.set(el, next);
}

function onLeave(e: ReactPointerEvent<HTMLElement>) {
  const el = e.currentTarget;
  const p = pending.get(el);
  if (p) cancelAnimationFrame(p.raf);
  pending.delete(el);
  el.style.transition = SPRING;
  el.style.transform = "";
}

/** Pointer handlers for the element that tilts (empty when wobble is off). */
export function usePosterTilt(): { onPointerMove?: typeof onMove; onPointerLeave?: typeof onLeave } {
  return useWobbleEnabled() ? { onPointerMove: onMove, onPointerLeave: onLeave } : {};
}

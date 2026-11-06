// Hysteresis for on-screen states that flap (the buffering spinner after a
// seek: the element's seeking / readyState toggle several times a second).
import { useEffect, useState } from "react";

/** Shown once `value` has been true for `onMs`; hidden once false for `offMs`. */
export function useSteady(value: boolean, onMs = 350, offMs = 400): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (value === shown) return;
    const id = setTimeout(() => setShown(value), value ? onMs : offMs);
    return () => clearTimeout(id);
  }, [value, shown, onMs, offMs]);
  return shown;
}

/** Pure form for tests: the shown state after a timeline of (time, value) samples. */
export function steadyAt(samples: readonly [number, boolean][], at: number, onMs = 350, offMs = 400): boolean {
  let shown = false;
  let since: number | null = null;
  let last = false;
  const step = (t: number) => {
    if (since !== null && last !== shown && t - since >= (last ? onMs : offMs)) {
      shown = last;
      since = null;
    }
  };
  for (const [t, v] of samples) {
    if (t > at) break;
    step(t);
    if (v !== last) {
      last = v;
      since = v !== shown ? t : null;
    } else if (since === null && v !== shown) since = t;
  }
  step(at);
  return shown;
}

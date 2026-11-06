// Some remotes (seen on the Samsung «Living Room») deliver one arrow press as two
// keydown events a few ms apart, so focus jumps two tabs. Drop an arrow
// keydown that repeats the same key < DUP_MS after the previous one: faster
// than any person or any TV's key auto-repeat.

const ARROWS: Record<number, string> = { 37: "ArrowLeft", 38: "ArrowUp", 39: "ArrowRight", 40: "ArrowDown" };
export const DUP_MS = 35;

export type KeyFilter = (key: string, t: number) => boolean;

/** Returns a filter: true = keep the event, false = it's a duplicate. */
export function makeKeyFilter(): KeyFilter {
  let lastKey = "";
  let lastT = -Infinity;
  return (key, t) => {
    const dup = key === lastKey && t - lastT < DUP_MS;
    lastKey = key;
    lastT = t;
    return !dup;
  };
}

/** Real TVs only (tests press keys faster than a person can). */
export function installKeyDedupe(): void {
  const keep = makeKeyFilter();
  window.addEventListener(
    "keydown",
    (e) => {
      const key = ARROWS[e.keyCode] ?? (e.key.startsWith("Arrow") ? e.key : "");
      if (!key || keep(key, performance.now())) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
}

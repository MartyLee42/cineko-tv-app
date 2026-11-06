// «Scrolling fast»: while arrow keys repeat quickly (held, or tapped < 330 ms
// apart) <html> gets .mt-fast, so per-card effects (the poster hop) skip and
// a weak TV spends its time on moving focus. Cleared 400 ms after the last arrow.
const ARROWS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
const ARROW_CODES = new Set([37, 38, 39, 40]);
export const FAST_GAP_MS = 330;
export const FAST_QUIET_MS = 400;

/** Pure: is this arrow press part of fast scrolling? */
export function isFastPress(now: number, last: number, repeat: boolean): boolean {
  return repeat || now - last < FAST_GAP_MS;
}

export function installFastNav(doc: Document = document): () => void {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const root = doc.documentElement;
  const onKey = (e: KeyboardEvent) => {
    if (!ARROWS.has(e.key) && !ARROW_CODES.has(e.keyCode)) return;
    const now = Date.now();
    if (isFastPress(now, last, e.repeat)) root.classList.add("mt-fast");
    last = now;
    clearTimeout(timer);
    timer = setTimeout(() => root.classList.remove("mt-fast"), FAST_QUIET_MS);
  };
  doc.addEventListener("keydown", onKey, true);
  return () => {
    doc.removeEventListener("keydown", onKey, true);
    clearTimeout(timer);
    root.classList.remove("mt-fast");
  };
}

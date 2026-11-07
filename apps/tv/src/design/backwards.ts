// «Красная комната»: sometimes a focused card's title plays backwards (mirrored for a moment,
// then it rights itself: looks/redroom.tsx + .rr-backwards). Rare by design: only about one
// title in three (stable from the id), each at most once per session, never two within a few
// seconds, never on long titles. Pure: no DOM.

/** Titles longer than this never play backwards (a mirrored long line is just noise). */
export const BACKWARDS_MAX_CHARS = 24;
/** At least this long between two backwards titles (ms). */
export const BACKWARDS_EVERY_MS = 6000;
/** How long the mirrored moment lasts, righting itself included (ms; redroom.css). */
export const BACKWARDS_MS = 420;

/** Stable 0…n-1 from an id. */
function bucket(id: string, n: number): number {
  let h = 11;
  for (let i = 0; i < id.length; i++) h = (h * 33 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % n;
}

/** Whether the title of the card `id` (just focused) plays backwards now. */
export function playsBackwards(o: { id: string | null; text: string; seen: ReadonlySet<string>; now: number; last: number }): boolean {
  if (!o.id || o.seen.has(o.id)) return false;
  const len = o.text.trim().length;
  if (len < 2 || len > BACKWARDS_MAX_CHARS) return false;
  if (o.now - o.last < BACKWARDS_EVERY_MS) return false;
  return bucket(o.id, 3) === 0;
}

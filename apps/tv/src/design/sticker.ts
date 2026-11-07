// «Стикербук»: each card is a sticker with its own slight tilt and maybe a
// strip of washi tape. Both come from the title's id (stable between renders
// and scrolls, unlike per-render randomness); the look is CSS keyed by
// [data-sticker] (design/looks/stickerbook.css). Pure: no DOM.

/** Sticker variants (tilt + tape); stickerbook.css styles 0…STICKER_KINDS-1. */
export const STICKER_KINDS = 6;

/** The sticker variant of an id (0…STICKER_KINDS-1). */
export function stickerOf(id: string): number {
  let h = 7;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % STICKER_KINDS;
}

/** How long OK on a card waits for the design's «pick» animation before opening (0 = at once). */
export function pickDelay(o: { pickMs: number | undefined; calm: boolean; fast: boolean; hasCard: boolean }): number {
  if (!o.pickMs || o.calm || o.fast || !o.hasCard) return 0;
  return Math.max(0, Math.min(o.pickMs, 300));
}

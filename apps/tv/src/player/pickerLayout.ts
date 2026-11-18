// Release picker geometry (1920×1080): online group + torrent rows, and the
// scroll that keeps the focused row in view. Pure, unit-tested.
export const ROW_H = 168;
export const ROW_GAP = 20;
export const LIST_TOP = 300;
/** List viewport: up to the footer. */
export const LIST_H = 1080 - LIST_TOP - 100;
/** Group headings in the list («Аниме · AniLiberty», «Торренты»). */
export const HEAD_H = 64;
export const PITCH = ROW_H + ROW_GAP;

/** Focused row: an online variant or a torrent release. */
export type Sel = { kind: "onl" | "rel"; i: number };

/** The «Онлайн / Торренты» tabs above the list, when both exist. */
export const TABS_H = 88;

/**
 * Vertical scroll for row `i` of the visible tab: one row of context above
 * it, never past the end. `headH` is the heading above the rows.
 */
export function pickerScroll(i: number, rows: number, headH = 0, listH = LIST_H): number {
  return Math.max(0, Math.min(headH + (i - 1) * PITCH, headH + rows * PITCH - listH));
}

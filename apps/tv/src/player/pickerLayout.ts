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

/**
 * Vertical scroll for the focused row. Without online rows it is the old
 * torrent-only formula (one row of context above the focused one).
 */
export function pickerScroll(sel: Sel, onlineRows: number, torrentRows: number, failedLine: boolean): number {
  if (onlineRows === 0 && !failedLine) {
    const visible = Math.floor(LIST_H / PITCH);
    return Math.max(0, Math.min(sel.i - 1, torrentRows - visible)) * PITCH;
  }
  const onlineH = HEAD_H + (failedLine ? 48 : 0) + onlineRows * PITCH;
  const y = sel.kind === "onl" ? HEAD_H + (failedLine ? 48 : 0) + sel.i * PITCH : onlineH + HEAD_H + sel.i * PITCH;
  const total = onlineH + HEAD_H + torrentRows * PITCH;
  return Math.max(0, Math.min(y - PITCH, total - LIST_H));
}

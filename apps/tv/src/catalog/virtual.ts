// Pure layout math for virtualized rows and grids. Everything is laid out
// with fixed item sizes, so positions are computed rather than measured.

/** Half-open range [start, end) of indexes to render around `focus`. */
export function windowRange(focus: number, count: number, before: number, after: number): [number, number] {
  if (count <= 0) return [0, 0];
  const f = clamp(focus, 0, count - 1);
  return [Math.max(0, f - before), Math.min(count, f + after + 1)];
}

/**
 * Items to render in a horizontal row: the focus window, widened to every
 * item actually on screen at `offset` (plus one on each side). At the end of
 * a row the focused card sits at the right edge, so the plain window (a few
 * before the focus) left the left part of the screen empty.
 */
export function rowWindow(focus: number, count: number, before: number, after: number, offset: number, pitch: number, viewport: number): [number, number] {
  const [a, b] = windowRange(focus, count, before, after);
  if (count <= 0 || pitch <= 0) return [a, b];
  const first = Math.max(0, Math.floor(offset / pitch) - 1);
  const last = Math.min(count, Math.ceil((offset + viewport) / pitch) + 1);
  return [Math.min(a, first), Math.max(b, last)];
}

/**
 * Horizontal track offset (px, positive = shift left) that puts the focused
 * item at the left edge, but never scrolls past the end of the content or
 * scrolls at all when everything fits.
 */
export function trackOffset(index: number, count: number, pitch: number, itemWidth: number, viewport: number): number {
  if (count <= 0) return 0;
  const contentWidth = (count - 1) * pitch + itemWidth;
  const maxOffset = Math.max(0, contentWidth - viewport);
  return clamp(clamp(index, 0, count - 1) * pitch, 0, maxOffset);
}

export function gridPos(index: number, cols: number): { row: number; col: number } {
  return { row: Math.floor(index / cols), col: index % cols };
}

export type Direction = "up" | "down" | "left" | "right";

/**
 * Index reached by moving one step in a grid of `count` items laid out
 * row-major in `cols` columns, or null when the move leaves the grid (the
 * caller then lets focus escape to the surrounding UI).
 */
export function gridNeighbor(index: number, count: number, cols: number, dir: Direction): number | null {
  const { row, col } = gridPos(index, cols);
  const lastRow = Math.floor((count - 1) / cols);
  switch (dir) {
    case "left":
      return col === 0 ? null : index - 1;
    case "right":
      return col === cols - 1 || index + 1 >= count ? null : index + 1;
    case "up":
      return row === 0 ? null : index - cols;
    case "down":
      if (row >= lastRow) return null;
      // The last row may be shorter: land on its last item.
      return Math.min(index + cols, count - 1);
  }
}

/** Rows of a grid to render around the focused row. */
export function gridWindow(focusIndex: number, count: number, cols: number, rowsBefore: number, rowsAfter: number): [number, number] {
  if (count <= 0) return [0, 0];
  const rows = Math.ceil(count / cols);
  const [r0, r1] = windowRange(gridPos(clamp(focusIndex, 0, count - 1), cols).row, rows, rowsBefore, rowsAfter);
  return [r0 * cols, Math.min(count, r1 * cols)];
}

/** True when focus is close enough to the end that the next page should load. */
export function nearEnd(index: number, count: number, threshold: number): boolean {
  return count > 0 && index >= count - threshold;
}

/**
 * The index a virtualized row/grid centres on: where the focused item's key
 * is now (lists change while focused: a refresh, a video moving to another
 * row, items added in front), else the last focused index, kept in range.
 */
export function trackedIndex(keys: readonly string[], focusedKey: string | null, lastIndex: number): number {
  if (focusedKey !== null) {
    const i = keys.indexOf(focusedKey);
    if (i >= 0) return i;
  }
  return clamp(lastIndex, 0, Math.max(0, keys.length - 1));
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

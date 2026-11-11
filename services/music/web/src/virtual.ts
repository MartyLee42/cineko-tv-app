// Windowed long lists: only the rows near the viewport are in the DOM, the
// rest is two spacers of the same height. Rows of one list are about the same
// height (it is measured from the rendered ones, so every design and screen
// width fits). Pure logic here, unit-tested in Node; the hook is in ui.tsx.

/** Lists up to this long render whole (no windowing). */
export const VIRTUAL_FROM = 80;

export interface Range {
  start: number;
  end: number; // exclusive
}

/**
 * Rows to render. offset: how far the viewport's top is below the list's top
 * (negative while the list starts lower on screen); view: viewport height.
 * The range is snapped to chunks, so small scrolls don't re-render.
 */
export function windowRange(count: number, rowH: number, offset: number, view: number, overscan = 12, chunk = 8): Range {
  if (count <= 0) return { start: 0, end: 0 };
  const h = rowH > 0 ? rowH : 56;
  const first = Math.floor(Math.max(0, offset) / h);
  const last = Math.ceil(Math.max(0, offset + view) / h);
  let start = Math.max(0, first - overscan);
  let end = Math.min(count, last + overscan);
  start = Math.floor(start / chunk) * chunk;
  end = Math.min(count, Math.ceil(end / chunk) * chunk);
  if (end <= start) {
    // Scrolled past the list (or above it, with a tiny viewport): keep a few rows.
    const at = Math.min(count, Math.max(0, first));
    start = Math.max(0, Math.min(at, count - overscan));
    end = Math.min(count, start + overscan);
  }
  return { start, end };
}

/** Average row height of the rendered rows (0 when none rendered). */
export function averageRow(renderedHeight: number, rendered: number): number {
  return rendered > 0 && renderedHeight > 0 ? renderedHeight / rendered : 0;
}

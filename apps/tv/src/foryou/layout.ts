// Pure geometry for the TV's Phase 6 screens (History list, Surprise toggles).
import type { HistoryLine } from "@martytv/ui";
import { clamp } from "../catalog/virtual";

export interface ListGeo {
  month: number;
  item: number;
}

export interface ListLayout {
  /** Top of every line (px). */
  tops: number[];
  /** Line index of every focusable item, in order. */
  items: number[];
  height: number;
}

/** Positions month headers and items one under another. */
export function listLayout<H>(lines: readonly HistoryLine<H>[], g: ListGeo): ListLayout {
  const tops: number[] = [];
  const items: number[] = [];
  let y = 0;
  lines.forEach((l, i) => {
    tops.push(y);
    if (l.type === "item") items.push(i);
    y += l.type === "month" ? g.month : g.item;
  });
  return { tops, items, height: y };
}

/**
 * Lines to render around the focused item (by item index): `before` / `after`
 * items, plus the month headers in between (and the one heading the first).
 */
export function lineWindow(layout: ListLayout, focusItem: number, before: number, after: number): [number, number] {
  const n = layout.items.length;
  if (n === 0) return [0, 0];
  const f = clamp(focusItem, 0, n - 1);
  const first = layout.items[Math.max(0, f - before)]!;
  const last = layout.items[Math.min(n - 1, f + after)]!;
  // Include the header right above the first rendered item.
  const start = first > 0 && layout.items.indexOf(first - 1) < 0 ? first - 1 : first;
  return [start, last + 1];
}

/** Page offset that keeps the focused line `anchor` px below the top (0 near the start). */
export function listScroll(layout: ListLayout, focusItem: number, anchor: number): number {
  const line = layout.items[clamp(focusItem, 0, Math.max(0, layout.items.length - 1))];
  if (line === undefined) return 0;
  return Math.max(0, layout.tops[line]! - anchor);
}

/** Next value in a cycle (Surprise toggles: kind, decade, rating). */
export function cycle<V>(values: readonly V[], current: V): V {
  const i = values.indexOf(current);
  return values[(i + 1) % values.length]!;
}

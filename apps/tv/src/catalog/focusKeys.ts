// Stable focus keys and resolvers for keyed navigation.
import type { Direction } from "./virtual";

/** Focus key of a card in a row/grid: stable across remounts (focus restore). */
export function cardKey(scope: string, id: string | number): string {
  return `${scope}-${id}`;
}

/**
 * Next key in an ordered list for a linear container: `axis` is the
 * direction the list runs in. Moves along the other axis return null so focus
 * escapes to the parent.
 */
export function linearNext(keys: readonly string[], current: string, dir: Direction, axis: "horizontal" | "vertical"): string | null {
  const along = axis === "horizontal" ? dir === "left" || dir === "right" : dir === "up" || dir === "down";
  if (!along) return null;
  const i = keys.indexOf(current);
  if (i < 0) return null;
  const step = dir === "right" || dir === "down" ? 1 : -1;
  return keys[i + step] ?? null;
}

/** Removes duplicate ids (paged TMDB lists may repeat items between pages). */
export function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

// «Подборки» on TV: a curated list's items as grid cards.
import type { MediaSummary, Schemas } from "@martytv/contracts";

type CuratedItem = Schemas["CuratedItem"];

/**
 * Titles in the catalog (the others are skipped on TV and only counted in the
 * header); ✓ follows the list's «watched» (finished or rated), so the marks
 * agree with «7 из 48 просмотрено».
 */
export function curatedCards(items: readonly CuratedItem[]): { media: MediaSummary[]; notes: CuratedItem[]; missing: number } {
  const media: MediaSummary[] = [];
  const notes: CuratedItem[] = [];
  const seen = new Set<string>();
  let missing = 0;
  for (const it of items) {
    if (!it.media) {
      missing++;
      continue;
    }
    // One card per title (card focus keys are per id).
    if (seen.has(it.media.id)) continue;
    seen.add(it.media.id);
    const me = it.media.me;
    media.push(me && it.watched && !me.completed ? { ...it.media, me: { ...me, completed: true } } : it.media);
    notes.push(it);
  }
  return { media, notes, missing };
}

/** The focused card's line: «№ 3 · кристалл времени». */
export function curatedNote(it: CuratedItem | undefined, rank: (n: number) => string): string {
  if (!it) return "";
  return [it.rank != null ? rank(it.rank) : null, it.note].filter(Boolean).join(" · ");
}

// «Подборки» pure helpers shared by the PWA and the TV app: progress labels,
// group order and the «Показать непросмотренные» filter. Structurally typed
// (no contracts import), no React, no DOM.
import type { MessageKey } from "./i18n";

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Group ids in display order (GET /curated already sorts; unknown ones go last). */
export const CURATED_GROUPS = ["thinkers", "directors", "polls", "modern", "ru"] as const;

export interface CuratedGroupLike {
  id: string;
}

/** Groups sorted by CURATED_GROUPS (stable; unknown ids keep their order at the end). */
export function orderCuratedGroups<G extends CuratedGroupLike>(groups: readonly G[]): G[] {
  const rank = (id: string) => {
    const i = (CURATED_GROUPS as readonly string[]).indexOf(id);
    return i < 0 ? CURATED_GROUPS.length : i;
  };
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => rank(a.g.id) - rank(b.g.id) || a.i - b.i)
    .map((x) => x.g);
}

/** Watched share 0–100 (rounded; 0 for an empty list). */
export function curatedPercent(watched: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((watched / count) * 100)));
}

/** «7 из 48 просмотрено» / short «7 / 48». */
export function curatedProgressLabel(watched: number, count: number, t: T, short = false): string {
  return t(short ? "curated.progress_short" : "curated.progress", { watched, count });
}

export interface CuratedItemLike {
  watched: boolean;
  media: unknown;
}

/** «Показать непросмотренные»: items not yet watched (titles missing from the catalog stay). */
export function unwatchedCurated<I extends CuratedItemLike>(items: readonly I[]): I[] {
  return items.filter((it) => !it.watched);
}

/** The localized group title. */
export function curatedGroupTitle(id: string, t: T, fallback: string): string {
  return (CURATED_GROUPS as readonly string[]).includes(id) ? t(`curated.group.${id}` as MessageKey) : fallback;
}

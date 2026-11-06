// «Смотреть онлайн» (no torrent): pure helpers for the button and the
// compact online picker on the title page (OnlineWatch.tsx).
import type { OnlineList, OnlineVariant } from "./sourcesApi";

export interface SourceGroup {
  provider: OnlineVariant["provider"];
  variants: OnlineVariant[];
}

/** Online (not anime) variants of a lookup; [] while loading / on error. */
export function onlineOnly(list: OnlineList | null | undefined): OnlineVariant[] {
  return (list?.items ?? []).filter((v) => v.provider.kind === "online");
}

/**
 * Variants grouped by source, in the server's ranking order (a source's
 * best variant decides its position); within a source the preferred voice
 * comes first, then the server's order.
 */
export function groupBySource(items: readonly OnlineVariant[]): SourceGroup[] {
  const out: SourceGroup[] = [];
  for (const v of items) {
    let g = out.find((x) => x.provider.id === v.provider.id);
    if (!g) {
      g = { provider: v.provider, variants: [] };
      out.push(g);
    }
    g.variants.push(v);
  }
  for (const g of out) {
    const i = g.variants.findIndex((v) => v.preferred);
    if (i > 0) g.variants.unshift(...g.variants.splice(i, 1));
  }
  return out;
}

/** The auto-pick: the server's preferred variant, else the best-ranked one. */
export function defaultVariant(items: readonly OnlineVariant[]): OnlineVariant | null {
  return items.find((v) => v.preferred) ?? items[0] ?? null;
}

/** Episodes a variant can play (season-level variants list theirs; one-episode variants have one). */
export function variantEpisodes(v: OnlineVariant): number[] {
  if (v.episode != null) return [v.episode];
  return [...new Set(v.episodes)].sort((a, b) => a - b);
}

/** Episode to preselect: the wanted one (next up) when this voice has it, else its first. */
export function defaultEpisode(v: OnlineVariant | null, wanted: number | null | undefined): number | null {
  if (!v) return null;
  const eps = variantEpisodes(v);
  if (wanted != null && eps.includes(wanted)) return wanted;
  return eps[0] ?? null;
}

/** Qualities best first (deduplicated). */
export function sortedQualities(qs: readonly number[]): number[] {
  return [...new Set(qs)].sort((a, b) => b - a);
}

// «Уточнить» (refine a release search): own query text and/or loose matching.
// Pure helpers for the query pre-fill and the per-title memory (this tab only).

export interface Refine {
  /** Own search text (2–100 chars); null = the automatic queries. */
  q: string | null;
  /** Also return uncertain matches (warning uncertain_match). */
  loose: boolean;
}

export const NO_REFINE: Refine = { q: null, loose: false };
export const QUERY_MIN = 2;
export const QUERY_MAX = 100;

export interface RefineTitle {
  /** Title in Russian (falls back to the UI-language title). */
  title: string;
  original_title?: string | null;
  year?: number | null;
  kind: "movie" | "series";
  season_number?: number | null;
}

/** Trims, collapses whitespace, caps at 100 chars. */
export function cleanQuery(q: string): string {
  return q.replace(/\s+/g, " ").trim().slice(0, QUERY_MAX).trim();
}

export function validQuery(q: string): boolean {
  const c = cleanQuery(q);
  return c.length >= QUERY_MIN && c.length <= QUERY_MAX;
}

const yearRe = (year: number) => new RegExp(`(^|\\s)\\(?${year}\\)?(?=\\s|$)`, "g");

/** "Начало 2010" → "Начало". */
export function withoutYear(q: string, year: number | null | undefined): string {
  if (!year) return cleanQuery(q);
  return cleanQuery(q.replace(yearRe(year), " "));
}

export function withYear(q: string, year: number | null | undefined): string {
  const base = withoutYear(q, year);
  return year ? cleanQuery(`${base} ${year}`) : base;
}

export function hasYear(q: string, year: number | null | undefined): boolean {
  return !!year && yearRe(year).test(q);
}

const seasonRe = /(^|\s)S\d{1,2}(E\d{1,3})?(?=\s|$)/gi;

/** Adds (or replaces) "S01" for a series season. */
export function withSeason(q: string, season: number): string {
  const base = cleanQuery(q.replace(seasonRe, " "));
  return cleanQuery(`${base} S${String(season).padStart(2, "0")}`);
}

export function hasSeason(q: string): boolean {
  return new RegExp(seasonRe.source, "i").test(q);
}

/** Pre-filled query: the Russian title + year. */
export function defaultQuery(t: RefineTitle): string {
  return withYear(t.title, t.year);
}

export type ChipKey = "original" | "local" | "no_year" | "year" | "season";

export interface QueryChip {
  key: ChipKey;
  /** The query the chip switches to. */
  query: string;
}

/**
 * Quick changes for the current query: switch to the original / Russian
 * title (keeping the year choice), drop or add the year, add "S01".
 * Chips that wouldn't change anything are left out.
 */
export function queryChips(t: RefineTitle, current: string): QueryChip[] {
  const q = cleanQuery(current);
  const keepYear = hasYear(q, t.year);
  const name = (title: string) => (keepYear ? withYear(title, t.year) : cleanQuery(title));
  const season = t.kind === "series" && t.season_number != null && hasSeason(q) ? ` S${String(t.season_number).padStart(2, "0")}` : "";
  const out: QueryChip[] = [];
  const orig = t.original_title?.trim();
  if (orig && orig.toLowerCase() !== t.title.trim().toLowerCase()) {
    const usingOrig = q.toLowerCase().includes(orig.toLowerCase());
    out.push(usingOrig ? { key: "local", query: cleanQuery(name(t.title) + season) } : { key: "original", query: cleanQuery(name(orig) + season) });
  }
  if (t.year) out.push(keepYear ? { key: "no_year", query: withoutYear(q, t.year) } : { key: "year", query: withYear(q, t.year) });
  if (t.kind === "series" && t.season_number != null && t.season_number > 0 && !hasSeason(q)) {
    out.push({ key: "season", query: withSeason(q, t.season_number) });
  }
  return out.filter((c) => c.query !== q && validQuery(c.query));
}

// ---------------------------------------------------------------- memory

const memory = new Map<string, Refine>();

/** Last refine for a title in this tab (all of its episodes share it). */
export function rememberedRefine(mediaId: string): Refine {
  return memory.get(mediaId) ?? NO_REFINE;
}

export function rememberRefine(mediaId: string, r: Refine) {
  if (!r.q && !r.loose) memory.delete(mediaId);
  else memory.set(mediaId, { q: r.q ? cleanQuery(r.q) : null, loose: r.loose });
}

export function isRefined(r: Refine): boolean {
  return !!r.q || r.loose;
}

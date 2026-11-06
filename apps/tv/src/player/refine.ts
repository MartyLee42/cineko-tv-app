// «Уточнить поиск»: the query the user edits and the quick edits (pure).
import type { Release } from "@martytv/contracts";

export const REFINE_MIN = 2;
export const REFINE_MAX = 100;

/** Pre-filled query: the title plus the year. */
export function refineDefault(title: string, year: number | null | undefined): string {
  const t = title.trim();
  return (year ? `${t} ${year}` : t).slice(0, REFINE_MAX);
}

/** Removes the trailing year (1900–2099) the pre-fill added; a title that is a year stays. */
export function stripYear(q: string): string {
  return q.trim().replace(/\s+(19|20)\d{2}$/, "").trim();
}

/** Appends a season tag ("S01"), replacing one already there. */
export function withSeason(q: string, season: number): string {
  const tag = `S${String(season).padStart(2, "0")}`;
  return `${q.replace(/(^|\s)S\d{1,2}(E\d{1,3})?(?=\s|$)/gi, " ").replace(/\s+/g, " ").trim()} ${tag}`.trim().slice(0, REFINE_MAX);
}

export function refineValid(q: string): boolean {
  const n = q.trim().length;
  return n >= REFINE_MIN && n <= REFINE_MAX;
}

/** A loose result the server isn't sure about. */
export function isUncertain(r: Pick<Release, "warnings">): boolean {
  return r.warnings.includes("uncertain_match");
}

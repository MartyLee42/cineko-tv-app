// Finding known films in catalog search results by title and year
// («Ленин в Октябре», the «Госкино» classics) and caching what was found.

export interface TitleCandidate {
  id: string;
  kind: string;
  title: string;
  original_title: string;
  year: number | null;
}

/** Lower case, ё→е, punctuation → spaces. (No \p{…} classes: old TV engines can't parse them.) */
export const normTitle = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-z0-9а-я]+/g, " ")
    .trim();

/**
 * The movie titled `title` (or one of `alt`) from `year` (±1) among search
 * results: an exact (normalised) title / original title wins, then a title
 * that starts with it. Null when nothing fits.
 */
export function pickByTitle<T extends TitleCandidate>(items: readonly T[] | null | undefined, title: string, year: number, alt: readonly string[] = []): T | null {
  const want = [title, ...alt].map(normTitle);
  const movies = (items ?? []).filter((m) => m.kind === "movie" && m.year !== null && Math.abs(m.year - year) <= 1);
  const names = (m: T) => [normTitle(m.title), normTitle(m.original_title)];
  const exact = movies.filter((m) => names(m).some((n) => want.includes(n)));
  const pool = exact.length
    ? exact
    : movies.filter((m) => names(m).some((n) => want.some((w) => n.startsWith(w) || w.startsWith(n))));
  if (!pool.length) return null;
  return pool.find((m) => m.year === year) ?? pool[0]!;
}

type KV = Pick<Storage, "getItem" | "setItem">;

function local(): KV | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

const TTL = 30 * 24 * 3600_000;

export function readCache<T>(key: string, lang: string, now = Date.now(), store: KV | null = local()): T | null {
  try {
    const raw = store?.getItem(key);
    if (!raw) return null;
    const c = JSON.parse(raw) as { lang?: string; at?: number; item?: T };
    if (c.item === undefined || c.item === null || c.lang !== lang || typeof c.at !== "number" || now - c.at > TTL) return null;
    return c.item;
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, lang: string, item: T, now = Date.now(), store: KV | null = local()): void {
  try {
    store?.setItem(key, JSON.stringify({ lang, at: now, item }));
  } catch {
    /* storage full / blocked: the search simply runs again */
  }
}

/**
 * Searches each `{ q, year }` (a few at a time) and keeps the found films in
 * list order; failed / missing searches are skipped.
 */
export async function findFilms<T extends TitleCandidate>(list: readonly { q: string; year: number }[], search: (q: string) => Promise<readonly T[]>, parallel = 3): Promise<T[]> {
  const out: (T | null)[] = new Array(list.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      const f = list[i]!;
      try {
        out[i] = pickByTitle(await search(f.q), f.q, f.year);
      } catch {
        out[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, list.length) }, worker));
  const seen = new Set<string>();
  return out.filter((m): m is T => !!m && !seen.has(m.id) && !!seen.add(m.id));
}

// Browse state ⇄ URL query string ⇄ API query. Pure functions (unit tested).
import type { MediaKind, Schemas } from "@martytv/contracts";

export type ListKey = Schemas["ListKey"];
export type SortKey = "popularity" | "rating" | "release_date" | "title";
export type RuntimeBucket = "short" | "medium" | "long";
export type ListKind = "all" | MediaKind;

export const LIST_KEYS: readonly ListKey[] = [
  "trending",
  "popular",
  "top_rated",
  "upcoming",
  "now_playing",
  "on_the_air",
  "airing_today",
];
export const SORT_KEYS: readonly SortKey[] = ["popularity", "rating", "release_date", "title"];
export const RUNTIME_BUCKETS: readonly RuntimeBucket[] = ["short", "medium", "long"];
/** Original languages offered in the filter (labels: catalog.lang.<code>). */
export const FILTER_LANGUAGES = ["en", "ru", "ko", "ja", "fr", "es", "de", "it", "zh", "hi", "tr"] as const;
export const RATING_STEPS = [5, 6, 7, 8] as const;

export interface DiscoverFilters {
  genres: number[];
  yearFrom: number | null;
  yearTo: number | null;
  runtime: RuntimeBucket | null;
  language: string | null;
  ratingMin: number | null;
  sort: SortKey;
}

export type BrowseState =
  | { mode: "list"; list: ListKey; kind: ListKind }
  | ({ mode: "discover"; kind: MediaKind } & DiscoverFilters);

export const EMPTY_FILTERS: DiscoverFilters = {
  genres: [],
  yearFrom: null,
  yearTo: null,
  runtime: null,
  language: null,
  ratingMin: null,
  sort: "popularity",
};

function int(v: string | null, min: number, max: number): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function oneOf<T extends string>(v: string | null, options: readonly T[]): T | null {
  return v != null && (options as readonly string[]).includes(v) ? (v as T) : null;
}

/** Reads browse state from the URL, ignoring anything malformed. */
export function parseBrowse(params: URLSearchParams): BrowseState {
  const list = oneOf(params.get("list"), LIST_KEYS);
  const rawKind = params.get("kind");
  if (list) {
    return { mode: "list", list, kind: oneOf(rawKind, ["all", "movie", "series"] as const) ?? defaultListKind(list) };
  }
  const kind: MediaKind = rawKind === "series" ? "series" : "movie";
  const genres = (params.get("genres") ?? "")
    .split(",")
    .map((g) => int(g, 1, 1_000_000))
    .filter((g): g is number => g != null);
  const rating = params.get("rating");
  const ratingNum = rating == null || rating === "" ? NaN : Number(rating);
  return {
    mode: "discover",
    kind,
    genres: [...new Set(genres)].sort((a, b) => a - b),
    yearFrom: int(params.get("year_from"), 1870, 2100),
    yearTo: int(params.get("year_to"), 1870, 2100),
    runtime: kind === "movie" ? oneOf(params.get("runtime"), RUNTIME_BUCKETS) : null,
    language: oneOf(params.get("lang"), FILTER_LANGUAGES),
    ratingMin: Number.isFinite(ratingNum) && ratingNum > 0 && ratingNum <= 10 ? ratingNum : null,
    sort: oneOf(params.get("sort"), SORT_KEYS) ?? "popularity",
  };
}

function defaultListKind(list: ListKey): ListKind {
  if (list === "trending") return "all";
  if (list === "on_the_air" || list === "airing_today") return "series";
  return "movie";
}

/** Serializes browse state to a canonical query string (defaults omitted). */
export function browseToParams(state: BrowseState): URLSearchParams {
  const p = new URLSearchParams();
  if (state.mode === "list") {
    p.set("list", state.list);
    p.set("kind", state.kind);
    return p;
  }
  p.set("kind", state.kind);
  if (state.genres.length) p.set("genres", state.genres.join(","));
  if (state.yearFrom != null) p.set("year_from", String(state.yearFrom));
  if (state.yearTo != null) p.set("year_to", String(state.yearTo));
  if (state.runtime && state.kind === "movie") p.set("runtime", state.runtime);
  if (state.language) p.set("lang", state.language);
  if (state.ratingMin != null) p.set("rating", String(state.ratingMin));
  if (state.sort !== "popularity") p.set("sort", state.sort);
  return p;
}

export interface DiscoverQuery {
  kind: MediaKind;
  genres?: string;
  year_from?: number;
  year_to?: number;
  runtime_min?: number;
  runtime_max?: number;
  original_language?: string;
  rating_min?: number;
  sort?: SortKey;
}

export function runtimeRange(bucket: RuntimeBucket | null): { runtime_min?: number; runtime_max?: number } {
  switch (bucket) {
    case "short":
      return { runtime_max: 89 };
    case "medium":
      return { runtime_min: 90, runtime_max: 150 };
    case "long":
      return { runtime_min: 151 };
    default:
      return {};
  }
}

/** Maps discover state to /catalog/discover query parameters. */
export function toDiscoverQuery(state: { kind: MediaKind } & DiscoverFilters): DiscoverQuery {
  const q: DiscoverQuery = { kind: state.kind, sort: state.sort };
  if (state.genres.length) q.genres = state.genres.join(",");
  // Swap an inverted range instead of sending an impossible query.
  let from = state.yearFrom;
  let to = state.yearTo;
  if (from != null && to != null && from > to) [from, to] = [to, from];
  if (from != null) q.year_from = from;
  if (to != null) q.year_to = to;
  if (state.kind === "movie") Object.assign(q, runtimeRange(state.runtime));
  if (state.language) q.original_language = state.language;
  if (state.ratingMin != null) q.rating_min = state.ratingMin;
  return q;
}

/** Number of non-default filters (shown as a badge on the mobile filter button). */
export function activeFilterCount(f: DiscoverFilters): number {
  return (
    (f.genres.length ? 1 : 0) +
    (f.yearFrom != null || f.yearTo != null ? 1 : 0) +
    (f.runtime ? 1 : 0) +
    (f.language ? 1 : 0) +
    (f.ratingMin != null ? 1 : 0)
  );
}

/** Home row (list + kind) → the translation key of its title, if there is one. */
export function listTitleKey(list: ListKey, kind: ListKind): string | null {
  const map: Record<string, string> = {
    "trending:all": "trending",
    "popular:movie": "popular_movies",
    "popular:series": "popular_series",
    "top_rated:movie": "top_rated_movies",
    "top_rated:series": "top_rated_series",
    "upcoming:movie": "upcoming_movies",
    "on_the_air:series": "on_the_air_series",
  };
  const key = map[`${list}:${kind}`];
  return key ? `catalog.row.${key}` : null;
}

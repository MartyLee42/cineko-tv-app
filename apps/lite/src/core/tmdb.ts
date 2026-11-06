// TMDB v3 straight from the browser (CORS: *). TMDB is blocked in some
// regions (Russia): on a network failure the client switches to the cub.red
// mirror and remembers the choice. Both hosts and the key can be overridden
// in Settings.
import { getSettings, LOCALE, lsGet, lsSet } from "./store";

/** Public key of the Lampa ecosystem (published in its online_mod plugin). */
export const DEFAULT_TMDB_KEY = "4ef0d7355d9ffb5151e987764708ce96";

export const API_HOSTS = {
  direct: "https://api.themoviedb.org/3",
  mirror: "https://apitmdb.cub.red/3",
} as const;
export const IMG_HOSTS = {
  direct: "https://image.tmdb.org/t/p/",
  mirror: "https://imagetmdb.cub.red/t/p/",
} as const;

type Route = "direct" | "mirror";
const API_PICK = "cineko.tmdb.api";
const IMG_PICK = "cineko.tmdb.img";

function other(r: Route): Route {
  return r === "direct" ? "mirror" : "direct";
}

function apiCandidates(): string[] {
  const s = getSettings();
  if (s.tmdbApi === "custom" && s.tmdbApiCustom.trim()) return [s.tmdbApiCustom.trim().replace(/\/+$/, "")];
  if (s.tmdbApi === "direct" || s.tmdbApi === "mirror") return [API_HOSTS[s.tmdbApi]];
  const first = (lsGet<Route>(API_PICK) ?? "direct") as Route;
  return [API_HOSTS[first], API_HOSTS[other(first)]];
}

export function tmdbLanguage(): string {
  return LOCALE[getSettings().lang] ?? "ru-RU";
}

const TEXT_FIELDS = ["title", "name", "overview", "tagline"];

/**
 * Fills empty texts of a Kazakh response from the Russian one (TMDB has
 * little kk metadata). Objects are matched by position, list items by id
 * (+ season/episode number) when they have one.
 */
export function fillBlanks(primary: unknown, fallback: unknown): unknown {
  if (Array.isArray(primary)) {
    if (!Array.isArray(fallback)) return primary;
    const keyOf = (x: unknown) => {
      const o = x as Record<string, unknown> | null;
      if (!o || typeof o !== "object") return null;
      if (o.id != null) return `id:${o.id}`;
      if (o.episode_number != null) return `e:${o.episode_number}`;
      if (o.season_number != null) return `s:${o.season_number}`;
      return null;
    };
    const byKey = new Map<string, unknown>();
    for (const f of fallback) {
      const k = keyOf(f);
      if (k) byKey.set(k, f);
    }
    return primary.map((x, i) => {
      const k = keyOf(x);
      return fillBlanks(x, k ? byKey.get(k) : fallback[i]);
    });
  }
  if (!primary || typeof primary !== "object" || !fallback || typeof fallback !== "object") return primary;
  const p = primary as Record<string, unknown>;
  const f = fallback as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const original = p.original_title ?? p.original_name;
  for (const [k, v] of Object.entries(p)) {
    // Untranslated texts come back empty (overview) or as the original title.
    const blank = v == null || v === "" || ((k === "title" || k === "name") && original != null && v === original);
    if (TEXT_FIELDS.includes(k) && blank && typeof f[k] === "string" && f[k] !== "") out[k] = f[k];
    // Genre names have no Kazakh translation at all (TMDB answers in English).
    else if (k === "genres" && Array.isArray(f[k])) out[k] = f[k];
    else if (v && typeof v === "object") out[k] = fillBlanks(v, f[k]);
    else out[k] = v;
  }
  return out;
}

function key(): string {
  return getSettings().tmdbKey.trim() || DEFAULT_TMDB_KEY;
}

const cache = new Map<string, { at: number; p: Promise<unknown> }>();
const TTL = 30 * 60_000;

export class TmdbError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => ctl?.abort(), ms);
  try {
    return await fetch(url, { signal: ctl?.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function load(path: string, query: string): Promise<unknown> {
  const hosts = apiCandidates();
  let lastErr: unknown = null;
  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i];
    let res: Response;
    try {
      res = await fetchWithTimeout(`${host}${path}?${query}`, i === 0 && hosts.length > 1 ? 7000 : 12000);
    } catch (e) {
      lastErr = e; // network error / timeout / blocked: try the next host
      continue;
    }
    if (res.status === 401) throw new TmdbError("TMDB: invalid API key", 401);
    if (res.status === 404) throw new TmdbError("TMDB: not found", 404);
    if (!res.ok) {
      lastErr = new TmdbError(`TMDB: HTTP ${res.status}`, res.status);
      if (res.status >= 500 || res.status === 403 || res.status === 429) continue;
      throw lastErr;
    }
    if (hosts.length > 1) {
      const pick: Route = host === API_HOSTS.mirror ? "mirror" : "direct";
      if (lsGet(API_PICK) !== pick) lsSet(API_PICK, pick);
    }
    return res.json();
  }
  throw lastErr instanceof Error ? lastErr : new TmdbError("TMDB: network error");
}

/** GET a TMDB path (cached 30 min per URL; language and key added). */
export function tmdb<T = unknown>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const q = new URLSearchParams();
  q.set("api_key", key());
  q.set("language", tmdbLanguage());
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const query = q.toString();
  const ck = path + "?" + query;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL) return hit.p as Promise<T>;
  let p: Promise<unknown>;
  if (q.get("language") === "kk-KZ") {
    const ru = new URLSearchParams(q);
    ru.set("language", "ru-RU");
    const fb = load(path, ru.toString()).catch(() => null);
    p = load(path, query).then(async (kk) => {
      const r = await fb;
      return r ? fillBlanks(kk, r) : kk;
    });
  } else p = load(path, query);
  p.catch(() => cache.delete(ck));
  cache.set(ck, { at: Date.now(), p });
  return p as Promise<T>;
}

export function clearTmdbCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------- images

let imgRoute: Route = (lsGet<Route>(IMG_PICK) as Route) || "direct";
let imgProbe: Promise<void> | null = null;

function imgBase(): string {
  const s = getSettings();
  if (s.tmdbImg === "custom" && s.tmdbImgCustom.trim()) return s.tmdbImgCustom.trim().replace(/\/?$/, "/");
  if (s.tmdbImg === "direct" || s.tmdbImg === "mirror") return IMG_HOSTS[s.tmdbImg];
  return IMG_HOSTS[imgRoute];
}

/** Checks once per session whether image.tmdb.org loads; else uses the mirror. */
export function probeImages(): Promise<void> {
  if (imgProbe) return imgProbe;
  imgProbe = new Promise<void>((resolve) => {
    if (typeof Image === "undefined" || getSettings().tmdbImg !== "auto") return resolve();
    const tryRoute = (r: Route, then: (ok: boolean) => void) => {
      const img = new Image();
      const timer = setTimeout(() => done(false), 6000);
      let finished = false;
      function done(ok: boolean) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        img.onload = img.onerror = null;
        then(ok);
      }
      img.onload = () => done(true);
      img.onerror = () => done(false);
      img.src = IMG_HOSTS[r] + "w92/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg?probe=" + Date.now();
    };
    tryRoute(imgRoute, (ok) => {
      if (ok) return resolve();
      const alt = other(imgRoute);
      tryRoute(alt, (ok2) => {
        if (ok2) {
          imgRoute = alt;
          lsSet(IMG_PICK, alt);
        }
        resolve();
      });
    });
  });
  return imgProbe;
}

export type ImgSize = "w92" | "w185" | "w300" | "w342" | "w500" | "w780" | "w1280" | "original" | "h632";

export function img(path: string | null | undefined, size: ImgSize = "w342"): string {
  if (!path) return "";
  return imgBase() + size + path;
}

/** <img onError>: retry the same picture on the other image host once. */
export function imgFallback(e: { currentTarget: HTMLImageElement }): void {
  const el = e.currentTarget;
  if (el.dataset.fb) {
    el.style.visibility = "hidden";
    return;
  }
  el.dataset.fb = "1";
  const src = el.src;
  for (const r of ["direct", "mirror"] as Route[]) {
    if (src.startsWith(IMG_HOSTS[r])) {
      el.src = IMG_HOSTS[other(r)] + src.slice(IMG_HOSTS[r].length);
      return;
    }
  }
  el.style.visibility = "hidden";
}

// ---------------------------------------------------------------- types

export type MediaType = "movie" | "tv";

export interface TmdbItem {
  id: number;
  media_type?: MediaType | "person";
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  profile_path?: string | null;
  overview?: string;
  vote_average?: number;
  vote_count?: number;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
  popularity?: number;
}

export interface Paged<T> {
  page: number;
  results: T[];
  total_pages: number;
  total_results: number;
}

export interface Genre {
  id: number;
  name: string;
}

export interface CastMember {
  id: number;
  name: string;
  character?: string;
  profile_path?: string | null;
}

export interface SeasonSummary {
  season_number: number;
  name: string;
  episode_count: number;
  poster_path?: string | null;
  air_date?: string | null;
}

export interface Details extends TmdbItem {
  genres?: Genre[];
  runtime?: number;
  episode_run_time?: number[];
  tagline?: string;
  status?: string;
  number_of_seasons?: number;
  seasons?: SeasonSummary[];
  imdb_id?: string | null;
  external_ids?: { imdb_id?: string | null };
  credits?: { cast: CastMember[]; crew: { id: number; name: string; job: string }[] };
  similar?: Paged<TmdbItem>;
  recommendations?: Paged<TmdbItem>;
  production_countries?: { iso_3166_1: string; name: string }[];
}

export interface Episode {
  episode_number: number;
  season_number: number;
  name: string;
  overview?: string;
  still_path?: string | null;
  air_date?: string | null;
  runtime?: number | null;
  vote_average?: number;
}

export interface SeasonDetails {
  season_number: number;
  name: string;
  episodes: Episode[];
}

// ---------------------------------------------------------------- helpers

export function titleOf(it: TmdbItem): string {
  return it.title || it.name || it.original_title || it.original_name || "";
}

export function yearOf(it: TmdbItem): string {
  return (it.release_date || it.first_air_date || "").slice(0, 4);
}

export function typeOf(it: TmdbItem, fallback: MediaType = "movie"): MediaType {
  if (it.media_type === "movie" || it.media_type === "tv") return it.media_type;
  if (it.first_air_date !== undefined || (it.name && !it.title)) return "tv";
  return fallback;
}

/** Keeps movies/series only, tagging each result with its type. */
export function onlyTitles(list: TmdbItem[], fallback?: MediaType): TmdbItem[] {
  return list
    .filter((x) => x.media_type !== "person")
    .map((x) => ({ ...x, media_type: typeOf(x, fallback) }));
}

export function details(type: MediaType, id: number): Promise<Details> {
  return tmdb<Details>(`/${type}/${id}`, { append_to_response: "credits,similar,recommendations,external_ids" });
}

export function season(id: number, n: number): Promise<SeasonDetails> {
  return tmdb<SeasonDetails>(`/tv/${id}/season/${n}`);
}

export function imdbOf(d: Details): string {
  return (d.external_ids?.imdb_id || d.imdb_id || "").trim();
}

export async function listPage(path: string, params: Record<string, string | number | undefined>, fallback?: MediaType, page = 1): Promise<Paged<TmdbItem>> {
  const r = await tmdb<Paged<TmdbItem>>(path, { ...params, page });
  return { ...r, results: onlyTitles(r.results ?? [], fallback) };
}

export function searchMulti(query: string, page = 1): Promise<Paged<TmdbItem>> {
  return listPage("/search/multi", { query, include_adult: "false" }, undefined, page);
}

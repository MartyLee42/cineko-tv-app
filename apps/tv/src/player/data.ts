// API calls for playback: release search, playback sources, episode lookup.
// Release lists and catalog data go through the shared React Query cache, so
// the picker, remote commands and Details reuse each other's results.
import { useQuery } from "@tanstack/react-query";
import { ApiError, unwrap, type Episode, type MediaDetail, type PlaybackSource, type ReleaseList, type Schemas, type Season } from "@martytv/contracts";
import { api } from "../api";
import { queryClient } from "../catalog/queries";
import type { PlayContext } from "./session";

export interface ReleaseQuery {
  media_id: string;
  season: number | null;
  episode: number | null;
  profile_id: string;
  lang: "en" | "ru";
  /** «Показать все»: rank without this device's playback profile (device_prefs=off). */
  all?: boolean;
}

export function releaseQuery(ctx: PlayContext): ReleaseQuery {
  return { media_id: ctx.media_id, season: ctx.season, episode: ctx.episode, profile_id: ctx.profile_id, lang: ctx.lang };
}

export const releasesKey = (q: ReleaseQuery) =>
  q.all ? (["releases", q.media_id, q.season, q.episode, q.profile_id, q.lang, "all"] as const) : (["releases", q.media_id, q.season, q.episode, q.profile_id, q.lang] as const);

/** Server caches searches ~30 min; keep ours a bit shorter. */
const RELEASES_STALE = 20 * 60_000;

export interface Refine {
  text: string;
  loose: boolean;
}

function getReleases(q: ReleaseQuery, refresh: boolean, refine?: Refine): Promise<ReleaseList> {
  const query: Record<string, string | number | boolean> = { profile_id: q.profile_id, lang: q.lang };
  if (refine) {
    query.q = refine.text.trim();
    if (refine.loose) query.loose = true;
  }
  if (q.season !== null) query.season = q.season;
  if (q.episode !== null) query.episode = q.episode;
  if (refresh) query.refresh = true;
  if (q.all) query.device_prefs = "off";
  return unwrap(api.GET("/media/{id}/releases", { params: { path: { id: q.media_id }, query } }));
}

export function fetchReleases(q: ReleaseQuery): Promise<ReleaseList> {
  return queryClient.fetchQuery({ queryKey: releasesKey(q), queryFn: () => getReleases(q, false), staleTime: RELEASES_STALE, retry: false });
}

/** "Search again": bypasses both caches. */
export async function refreshReleases(q: ReleaseQuery): Promise<ReleaseList> {
  const list = await getReleases(q, true);
  queryClient.setQueryData(releasesKey(q), list);
  return list;
}

export function cachedReleases(q: ReleaseQuery): ReleaseList | undefined {
  return queryClient.getQueryData<ReleaseList>(releasesKey(q));
}

export function useReleases(q: ReleaseQuery) {
  return useQuery({ queryKey: releasesKey(q), queryFn: () => getReleases(q, false), staleTime: RELEASES_STALE, retry: false });
}

/** «Уточнить поиск»: the user's own query (and uncertain matches when `loose`). */
export function useRefinedReleases(q: ReleaseQuery, refine: Refine | null) {
  return useQuery({
    queryKey: [...releasesKey(q), "refine", refine?.text ?? "", refine?.loose ?? false],
    enabled: !!refine,
    queryFn: () => getReleases(q, false, refine!),
    staleTime: RELEASES_STALE,
    retry: false,
  });
}

/** Releases once a query is known (Details' auto-selected source); shares the picker's cache. */
export function useReleasesLazy(q: ReleaseQuery | null) {
  return useQuery({
    queryKey: q ? releasesKey(q) : ["releases", "none"],
    enabled: !!q,
    queryFn: () => getReleases(q!, false),
    staleTime: RELEASES_STALE,
    retry: false,
  });
}

// ---------------------------------------------------------------- online (anime) variants

export type OnlineList = Schemas["OnlineList"];
export type OnlineVariant = Schemas["OnlineVariant"];

export const onlineKey = (q: ReleaseQuery) => ["online", q.media_id, q.season, q.episode, q.profile_id, q.lang] as const;

/** GET /media/{id}/online: variants from the profile's online/anime sources (fast, separate from torrents). */
export function useOnline(q: ReleaseQuery) {
  return useQuery({
    queryKey: onlineKey(q),
    queryFn: () => {
      const query: Record<string, string | number> = { profile_id: q.profile_id, lang: q.lang };
      if (q.season !== null) query.season = q.season;
      if (q.season !== null && q.episode !== null) query.episode = q.episode;
      return unwrap(api.GET("/media/{id}/online", { params: { path: { id: q.media_id }, query } }));
    },
    staleTime: RELEASES_STALE,
    retry: false,
  });
}

/** GET /media/{id}/online outside React (next episode of an online source). */
export function fetchOnline(q: ReleaseQuery): Promise<OnlineList> {
  const query: Record<string, string | number> = { profile_id: q.profile_id, lang: q.lang };
  if (q.season !== null) query.season = q.season;
  if (q.season !== null && q.episode !== null) query.episode = q.episode;
  return unwrap(api.GET("/media/{id}/online", { params: { path: { id: q.media_id }, query } }));
}

/** Online source: another quality (same source, new stream_url). */
export function patchQuality(id: string, quality: number): Promise<PlaybackSource> {
  return unwrap(api.PATCH("/playback/sources/{id}", { params: { path: { id } }, body: { quality } }));
}

export function createSource(body: { media_id: string; release_id: string; episode_id?: string; profile_id: string; quality?: number }): Promise<PlaybackSource> {
  return unwrap(api.POST("/playback/sources", { body }));
}

export function getSource(id: string): Promise<PlaybackSource> {
  return unwrap(api.GET("/playback/sources/{id}", { params: { path: { id } } }));
}

/** The viewer cancelled while it loaded: the server stops preparing it (and drops a torrent it just added). Best effort. */
export function cancelSource(id: string): void {
  try {
    void api.DELETE("/playback/sources/{id}", { params: { path: { id } } }).catch(() => undefined);
  } catch {
    // Best effort.
  }
}

/** Error code for a failed API call (contract codes, else by status). */
export function apiErrorCode(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "network_error") return "network";
    if (e.code && e.code !== "error") return e.code;
    if (e.status === 404) return "release_unavailable";
    if (e.status === 502 || e.status === 503) return "torrserver_unavailable";
    return `http_${e.status}`;
  }
  return "generic";
}

export function loadMedia(id: string, lang: "en" | "ru"): Promise<MediaDetail> {
  return queryClient.fetchQuery({
    queryKey: ["media", id, lang],
    queryFn: () => unwrap(api.GET("/media/{id}", { params: { path: { id }, query: { lang } } })),
    staleTime: 10 * 60_000,
  });
}

export function cachedMedia(id: string, lang: "en" | "ru"): MediaDetail | undefined {
  return queryClient.getQueryData<MediaDetail>(["media", id, lang]);
}

export function loadSeason(id: string, season: number, lang: "en" | "ru"): Promise<Season> {
  return queryClient.fetchQuery({
    queryKey: ["media", id, "season", season, lang],
    queryFn: () => unwrap(api.GET("/media/{id}/seasons/{season}", { params: { path: { id, season }, query: { lang } } })),
    staleTime: 10 * 60_000,
  });
}

export function cachedSeason(id: string, season: number, lang: "en" | "ru"): Season | undefined {
  return queryClient.getQueryData<Season>(["media", id, "season", season, lang]);
}

/**
 * Finds an episode by id: cached seasons first, then the series' seasons in
 * order (regular seasons before specials).
 */
export async function findEpisode(mediaId: string, episodeId: string, lang: "en" | "ru"): Promise<Episode | null> {
  const media = await loadMedia(mediaId, lang);
  const order = [...media.seasons].sort((a, b) => (a.season_number === 0 ? 1 : 0) - (b.season_number === 0 ? 1 : 0) || a.season_number - b.season_number);
  for (const s of order) {
    const hit = cachedSeason(mediaId, s.season_number, lang)?.episodes.find((e) => e.id === episodeId);
    if (hit) return hit;
  }
  for (const s of order) {
    const season = await loadSeason(mediaId, s.season_number, lang);
    const hit = season.episodes.find((e) => e.id === episodeId);
    if (hit) return hit;
  }
  return null;
}

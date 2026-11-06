import { keepPreviousData, useInfiniteQuery, useQuery, type InfiniteData } from "@tanstack/react-query";
import { ApiError, unwrap, type MediaKind, type MediaPage } from "@martytv/contracts";
import { catalogLang } from "@martytv/media-types";
import { useI18n } from "@martytv/ui";
import { api } from "../api";
import type { DiscoverQuery, ListKey, ListKind } from "./filters";
import { useActiveProfile } from "../watch/ActiveProfile";
import { useHideWatchedOverride } from "../watch/queries";

/**
 * Per-profile catalog parameters: profile_id (server applies hide_anime /
 * hide_watched and annotates items with `me`) plus the session hide-watched
 * override. Spread into the query and into the query key.
 */
export function useProfileParams(withHideWatched = false): { profile_id?: string; hide_watched?: boolean } {
  const { profileId } = useActiveProfile();
  const override = useHideWatchedOverride();
  if (!profileId) return {};
  return { profile_id: profileId, ...(withHideWatched && override != null && { hide_watched: override }) };
}

/** Content language for catalog requests (follows the UI locale). */
export function useCatalogLang() {
  return catalogLang(useI18n().locale);
}

/** True for the 503 the API returns when TMDB is not configured. */
export function isCatalogUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.code === "catalog_unavailable";
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export function useCatalogConfig() {
  return useQuery({
    queryKey: ["catalog", "config"],
    queryFn: () => unwrap(api.GET("/catalog/config")),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

export function useHomeRows() {
  const lang = useCatalogLang();
  const pp = useProfileParams();
  return useQuery({
    queryKey: ["catalog", "home", lang, pp],
    queryFn: async () => (await unwrap(api.GET("/catalog/home", { params: { query: { lang, ...pp } } }))).rows,
    staleTime: 10 * 60_000,
  });
}

export function useGenres(kind: MediaKind) {
  const lang = useCatalogLang();
  return useQuery({
    queryKey: ["catalog", "genres", kind, lang],
    queryFn: async () => (await unwrap(api.GET("/catalog/genres", { params: { query: { kind, lang } } }))).items,
    staleTime: Infinity,
  });
}

const nextPage = (last: MediaPage) => (last.page < Math.min(last.total_pages, 500) ? last.page + 1 : undefined);

export type MediaPages = InfiniteData<MediaPage>;

export function useDiscover(query: DiscoverQuery, enabled = true) {
  const lang = useCatalogLang();
  const pp = useProfileParams(true);
  return useInfiniteQuery({
    queryKey: ["catalog", "discover", lang, query, pp],
    queryFn: ({ pageParam }) =>
      unwrap(api.GET("/catalog/discover", { params: { query: { ...query, page: pageParam, lang, ...pp } } })),
    initialPageParam: 1,
    getNextPageParam: nextPage,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useCatalogList(list: ListKey, kind: ListKind, enabled = true) {
  const lang = useCatalogLang();
  const pp = useProfileParams(true);
  return useInfiniteQuery({
    queryKey: ["catalog", "list", lang, list, kind, pp],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/catalog/lists/{list}", {
          params: { path: { list }, query: { kind, page: pageParam, lang, ...pp } },
        }),
      ),
    initialPageParam: 1,
    getNextPageParam: nextPage,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useSearch(q: string, kind: ListKind) {
  const lang = useCatalogLang();
  const pp = useProfileParams();
  return useInfiniteQuery({
    queryKey: ["catalog", "search", lang, q, kind, pp],
    queryFn: ({ pageParam }) =>
      unwrap(api.GET("/catalog/search", { params: { query: { q, kind, page: pageParam, lang, ...pp } } })),
    initialPageParam: 1,
    getNextPageParam: nextPage,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    enabled: q.length > 0,
  });
}

export function useMedia(id: string) {
  const lang = useCatalogLang();
  const pp = useProfileParams();
  return useQuery({
    queryKey: ["media", id, lang, pp],
    queryFn: () => unwrap(api.GET("/media/{id}", { params: { path: { id }, query: { lang, ...pp } } })),
    staleTime: 10 * 60_000,
  });
}

export function useSeason(id: string, season: number | null) {
  const lang = useCatalogLang();
  return useQuery({
    queryKey: ["media", id, "season", season, lang],
    queryFn: () =>
      unwrap(api.GET("/media/{id}/seasons/{season}", { params: { path: { id, season: season ?? 0 }, query: { lang } } })),
    enabled: season != null,
    placeholderData: keepPreviousData,
    staleTime: 10 * 60_000,
  });
}

export function useRelated(id: string, which: "similar" | "recommendations") {
  const lang = useCatalogLang();
  const pp = useProfileParams();
  return useQuery({
    queryKey: ["media", id, which, lang, pp],
    queryFn: async () => {
      const opts = { params: { path: { id }, query: { lang, ...pp } } };
      const page =
        which === "similar"
          ? await unwrap(api.GET("/media/{id}/similar", opts))
          : await unwrap(api.GET("/media/{id}/recommendations", opts));
      return page.items;
    },
    staleTime: 10 * 60_000,
  });
}

export function useProviders(id: string) {
  return useQuery({
    queryKey: ["media", id, "providers"],
    queryFn: () => unwrap(api.GET("/media/{id}/providers", { params: { path: { id } } })),
    staleTime: 60 * 60_000,
    retry: false,
  });
}

/** An actor's / director's page: bio and their films and series. */
export function usePerson(tmdbId: number) {
  const lang = useCatalogLang();
  const pp = useProfileParams();
  return useQuery({
    queryKey: ["person", tmdbId, lang, pp],
    queryFn: () => unwrap(api.GET("/people/{tmdb_id}", { params: { path: { tmdb_id: tmdbId }, query: { lang, ...pp } } })),
    enabled: tmdbId > 0,
    staleTime: 10 * 60_000,
  });
}

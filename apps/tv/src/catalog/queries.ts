// Catalog data hooks (React Query). Content language follows the UI locale,
// and every query key includes it, so switching language refetches.
import { QueryClient, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ApiError, unwrap, type CatalogConfig, type MediaKind, type MediaPage } from "@martytv/contracts";
import { catalogLang } from "@martytv/media-types";
import { useI18n } from "@martytv/ui";
import { api } from "../api";
import { uniqueById } from "./focusKeys";
import { useActiveProfileId } from "../profile/active";

/** `profile_id` query param (annotates items with `me`, applies hide_anime/hide_watched). */
function who(profile: string | null): { profile_id?: string } {
  return profile ? { profile_id: profile } : {};
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10 * 60_000,
      gcTime: 30 * 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      // Client errors and "TMDB not configured" won't fix themselves.
      retry: (count, err) => count < 1 && !(err instanceof ApiError && err.status >= 400 && err.status !== 429),
    },
  },
});

/** TMDB isn't configured on the server. */
export function isUnavailable(err: unknown, cfg?: CatalogConfig): boolean {
  if (cfg && !cfg.available) return true;
  return err instanceof ApiError && (err.code === "catalog_unavailable" || err.status === 503);
}

function useLang() {
  return catalogLang(useI18n().locale);
}

export function useCatalogConfig() {
  return useQuery({
    queryKey: ["catalog", "config"],
    queryFn: () => unwrap(api.GET("/catalog/config")),
    staleTime: Infinity,
  });
}

export function useHome() {
  const lang = useLang();
  const profile = useActiveProfileId();
  return useQuery({
    queryKey: ["catalog", "home", lang, profile],
    queryFn: () => unwrap(api.GET("/catalog/home", { params: { query: { lang, ...who(profile) } } })),
  });
}

export function useMedia(id: string) {
  const lang = useLang();
  const profile = useActiveProfileId();
  return useQuery({
    queryKey: ["media", id, lang],
    // profile_id adds `me` (watchlist state); the key stays profile-free so
    // remote commands and the player share the cached title.
    queryFn: () => unwrap(api.GET("/media/{id}", { params: { path: { id }, query: { lang, ...who(profile) } } })),
  });
}

/** Details for an id once known (Home's hero loads them after focus rests). */
export function useMediaLazy(id: string | null) {
  const lang = useLang();
  return useQuery({
    queryKey: ["media", id, lang],
    enabled: !!id,
    queryFn: () => unwrap(api.GET("/media/{id}", { params: { path: { id: id! }, query: { lang } } })),
  });
}

export function useRelated(id: string, which: "similar" | "recommendations", enabled: boolean) {
  const lang = useLang();
  const profile = useActiveProfileId();
  return useQuery({
    queryKey: ["related", id, which, lang, profile],
    enabled,
    queryFn: () =>
      which === "similar"
        ? unwrap(api.GET("/media/{id}/similar", { params: { path: { id }, query: { lang, ...who(profile) } } }))
        : unwrap(api.GET("/media/{id}/recommendations", { params: { path: { id }, query: { lang, ...who(profile) } } })),
  });
}

export function useSeason(id: string, season: number | null) {
  const lang = useLang();
  return useQuery({
    queryKey: ["media", id, "season", season, lang],
    enabled: season !== null,
    queryFn: () => unwrap(api.GET("/media/{id}/seasons/{season}", { params: { path: { id, season: season! }, query: { lang } } })),
  });
}

export function useGenres(kind: MediaKind) {
  const lang = useLang();
  return useQuery({
    queryKey: ["catalog", "genres", kind, lang],
    staleTime: 24 * 3600_000,
    queryFn: () => unwrap(api.GET("/catalog/genres", { params: { query: { kind, lang } } })).then((r) => r.items),
  });
}

export type SortKey = "popularity" | "rating" | "release_date" | "title";
export const SORTS: SortKey[] = ["popularity", "rating", "release_date", "title"];

const pages = {
  initialPageParam: 1,
  getNextPageParam: (last: MediaPage) => (last.page < Math.min(last.total_pages, 500) ? last.page + 1 : undefined),
  select: (data: { pages: MediaPage[] }) => ({
    items: uniqueById(data.pages.flatMap((p) => p.items)),
    total: data.pages[0]?.total_results ?? 0,
  }),
};

export function useDiscover(kind: MediaKind, genre: number | null, sort: SortKey) {
  const lang = useLang();
  const profile = useActiveProfileId();
  return useInfiniteQuery({
    queryKey: ["catalog", "discover", kind, genre, sort, lang, profile],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/catalog/discover", {
          params: { query: { kind, sort, page: pageParam, lang, ...who(profile), ...(genre !== null ? { genres: String(genre) } : {}) } },
        }),
      ),
    ...pages,
  });
}

export function useSearch(q: string) {
  const lang = useLang();
  const profile = useActiveProfileId();
  return useInfiniteQuery({
    queryKey: ["catalog", "search", q, lang, profile],
    enabled: q.length > 0,
    queryFn: ({ pageParam }) => unwrap(api.GET("/catalog/search", { params: { query: { q, kind: "all", page: pageParam, lang, ...who(profile) } } })),
    ...pages,
  });
}

/** An actor's / director's page (OK on a cast card in Details). */
export function usePerson(tmdbId: number) {
  const lang = useLang();
  const profile = useActiveProfileId();
  return useQuery({
    queryKey: ["person", tmdbId, lang, profile],
    queryFn: () => unwrap(api.GET("/people/{tmdb_id}", { params: { path: { tmdb_id: tmdbId }, query: { lang, ...who(profile) } } })),
  });
}

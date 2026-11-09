import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError, unwrap, type PlaybackSource, type ReleaseList } from "@martytv/contracts";
import { api } from "../api";
import { useCatalogLang } from "../catalog/queries";
import { releaseParams, type RankFor, type ReleaseTarget } from "./releases";
import { NO_REFINE, type Refine } from "./refine";

type Lang = "en" | "ru";

export const releasesKey = (t: ReleaseTarget, profileId: string | undefined, lang: Lang, refine: Refine = NO_REFINE, rank: RankFor = {}) =>
  [
    "releases",
    t.media_id,
    t.season_number ?? null,
    t.episode_number ?? null,
    profileId ?? null,
    lang,
    ...(refine.q || refine.loose ? [{ q: refine.q, loose: refine.loose }] : []),
    ...(rank.device_id || rank.client_id || rank.all ? [{ rank: rank.device_id ?? rank.client_id ?? null, all: !!rank.all }] : []),
  ] as const;

export function fetchReleases(
  t: ReleaseTarget,
  opts: { profile_id?: string; refresh?: boolean; lang: Lang; q?: string | null; loose?: boolean; rank?: RankFor },
) {
  return unwrap(
    api.GET("/media/{id}/releases", { params: { path: { id: t.media_id }, query: releaseParams(t, opts) } }),
  );
}

/** Same cache entry the list uses, so "Play best" after browsing reuses the search. */
export function releasesQuery(t: ReleaseTarget, profileId: string | undefined, lang: Lang, refine: Refine = NO_REFINE, rank: RankFor = {}) {
  return {
    queryKey: releasesKey(t, profileId, lang, refine, rank),
    queryFn: () => fetchReleases(t, { profile_id: profileId, lang, q: refine.q, loose: refine.loose, rank }),
    // The server caches searches ~30 min; searches are slow, so don't repeat them eagerly.
    staleTime: 10 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  };
}

export function useReleases(t: ReleaseTarget | null, profileId: string | undefined, refine: Refine = NO_REFINE, rank: RankFor = {}) {
  const lang = useCatalogLang();
  return useQuery({ ...releasesQuery(t ?? { media_id: "" }, profileId, lang, refine, rank), enabled: !!t });
}

/** "Search again": bypasses the server cache and replaces the cached list. */
export function useRefreshReleases(t: ReleaseTarget | null, profileId: string | undefined, refine: Refine = NO_REFINE, rank: RankFor = {}) {
  const qc = useQueryClient();
  const lang = useCatalogLang();
  return useMutation({
    mutationFn: () => fetchReleases(t!, { profile_id: profileId, lang, refresh: true, q: refine.q, loose: refine.loose, rank }),
    onSuccess: (data: ReleaseList) => qc.setQueryData(releasesKey(t!, profileId, lang, refine, rank), data),
  });
}

export function bestRelease(qc: QueryClient, t: ReleaseTarget, profileId: string | undefined, lang: Lang, rank: RankFor = {}) {
  return qc.fetchQuery(releasesQuery(t, profileId, lang, NO_REFINE, rank)).then((list) => list.items[0] ?? null);
}

export function createSource(body: { media_id: string; release_id: string; episode_id?: string; profile_id?: string; quality?: number }) {
  return unwrap(api.POST("/playback/sources", { body }));
}

/** The viewer gave up on a source while it loaded: the server stops preparing it (best effort). */
export function cancelSource(id: string): void {
  void api.DELETE("/playback/sources/{id}", { params: { path: { id } } }).catch(() => undefined);
}

export const sourceKey = (id: string) => ["playback-source", id] as const;

/** Polls a source about once a second while it is preparing. */
export function usePlaybackSource(id: string | null | undefined, initial?: PlaybackSource | null) {
  return useQuery({
    queryKey: sourceKey(id ?? ""),
    queryFn: () => unwrap(api.GET("/playback/sources/{id}", { params: { path: { id: id! } } })),
    enabled: !!id,
    initialData: initial && initial.id === id ? initial : undefined,
    initialDataUpdatedAt: 0,
    refetchInterval: (q) => (q.state.data?.status === "preparing" || !q.state.data ? 1000 : false),
    refetchOnWindowFocus: false,
    retry: 1,
    staleTime: 0,
  });
}

/** API error → short machine code for messages ("release_unavailable", "network", …). */
export function apiErrorCode(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return "network";
    if (err.status === 404 && (err.code === "not_found" || err.code === "error")) return "release_unavailable";
    return err.code;
  }
  return "failed";
}

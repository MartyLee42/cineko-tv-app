// Sources: GET /sources (settings), GET /media/{id}/online (anime/online
// variants in the release list) and PATCH quality of an online source.
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { unwrap, type PlaybackSource, type Schemas } from "@martytv/contracts";
import { api } from "../api";
import { useCatalogLang } from "../catalog/queries";
import type { ReleaseTarget } from "./releases";

export type OnlineVariant = Schemas["OnlineVariant"];
export type OnlineList = Schemas["OnlineList"];
export type SourceItem = Schemas["SourceItem"];
export type AdminSource = Schemas["AdminSource"];

type Lang = "en" | "ru";

export const onlineKey = (t: ReleaseTarget, profileId: string | undefined, lang: Lang) =>
  ["online", t.media_id, t.season_number ?? null, t.episode_number ?? null, profileId ?? null, lang] as const;

export function fetchOnline(t: ReleaseTarget, profileId: string | undefined, lang: Lang, refresh = false) {
  return unwrap(
    api.GET("/media/{id}/online", {
      params: {
        path: { id: t.media_id },
        query: {
          ...(t.season_number != null && { season: t.season_number }),
          ...(t.season_number != null && t.episode_number != null && { episode: t.episode_number }),
          ...(profileId && { profile_id: profileId }),
          ...(refresh && { refresh: true }),
          lang,
        },
      },
    }),
  );
}

/** Online/anime variants for a title or episode (fast; doesn't wait for torrents). */
export function useOnline(t: ReleaseTarget | null, profileId: string | undefined) {
  const lang = useCatalogLang();
  const target = t ?? { media_id: "" };
  return useQuery({
    queryKey: onlineKey(target, profileId, lang),
    queryFn: () => fetchOnline(target, profileId, lang),
    enabled: !!t?.media_id,
    staleTime: 10 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export const sourcesKey = (profileId: string | null | undefined) => ["sources", profileId ?? null] as const;

/** Every registered source with this profile's choice. */
export function useSources(profileId: string | null | undefined) {
  return useQuery({
    queryKey: sourcesKey(profileId),
    queryFn: () => unwrap(api.GET("/sources", { params: { query: profileId ? { profile_id: profileId } : {} } })),
    staleTime: 60_000,
  });
}

/** After the selection changed: searches made with the old one are stale. */
export function invalidateSearches(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ["releases"] });
  void qc.invalidateQueries({ queryKey: ["online"] });
  void qc.invalidateQueries({ queryKey: ["sources"] });
}

/** PATCH {quality}: the same source with a new stream_url. */
export function setSourceQuality(id: string, quality: number): Promise<PlaybackSource> {
  return unwrap(api.PATCH("/playback/sources/{id}", { params: { path: { id } }, body: { quality } }));
}

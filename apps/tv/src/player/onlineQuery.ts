// «Смотреть онлайн»: /online for Details, fetched lazily (shares the release
// picker's cache key).
import { useQuery } from "@tanstack/react-query";
import { unwrap } from "@martytv/contracts";
import { api } from "../api";
import { onlineKey, type OnlineList, type ReleaseQuery } from "./data";

/** Same cache lifetime as the release picker's /online query. */
const ONLINE_STALE = 20 * 60_000;

function getOnline(q: ReleaseQuery): Promise<OnlineList> {
  const query: Record<string, string | number> = { profile_id: q.profile_id, lang: q.lang };
  if (q.season !== null) query.season = q.season;
  if (q.season !== null && q.episode !== null) query.episode = q.episode;
  return unwrap(api.GET("/media/{id}/online", { params: { path: { id: q.media_id }, query } }));
}

/**
 * /online for Details: the key is known at once (cached data shows
 * immediately), the request starts only when `enabled` (after Details settled).
 */
export function useOnlineLazy(q: ReleaseQuery | null, enabled: boolean) {
  return useQuery({
    queryKey: q ? onlineKey(q) : ["online", "none"],
    enabled: !!q && enabled,
    queryFn: () => getOnline(q!),
    staleTime: ONLINE_STALE,
    retry: false,
  });
}

// «Конструктивизм» data on web Home: the viewing plan, the week's
// «стахановец» (the account's profiles) and the «Госкино» classics.
import { useQuery } from "@tanstack/react-query";
import { unwrap, type MediaSummary } from "@martytv/contracts";
import { finishedThisYear, GOSKINO_LIST_ID, planOf, readCvCache, stakhanovets, takeNewlyFinished, writeCvCache, type HistLike } from "@martytv/ui";
import { api } from "../api";
import { useActiveProfile } from "../watch/ActiveProfile";
import { useCatalogLang } from "./queries";

async function history(id: string, lang: "ru" | "en", pages: number): Promise<HistLike[]> {
  const items: HistLike[] = [];
  let cursor = "";
  for (let i = 0; i < pages; i++) {
    const r = await unwrap(api.GET("/profiles/{id}/history", { params: { path: { id }, query: { lang, limit: 100, ...(cursor ? { cursor } : {}) } } })).catch(() => null);
    if (!r) break;
    items.push(...r.items);
    if (!r.next_cursor) break;
    cursor = r.next_cursor;
  }
  return items;
}

/** The plan (this profile, this year), the week's best viewer, and titles finished since the last look (once each). */
export function useCvStats(enabled: boolean) {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return useQuery({
    queryKey: ["cv", "stats", profileId, lang],
    enabled: enabled && !!profileId,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const profiles = (await unwrap(api.GET("/profiles"))).items;
      const lists = await Promise.all(profiles.map(async (p) => ({ id: p.id, name: p.name, items: await history(p.id, lang, p.id === profileId ? 3 : 1) })));
      const mine = lists.find((l) => l.id === profileId)?.items ?? [];
      const now = new Date();
      return {
        plan: planOf(mine, now),
        hero: stakhanovets(lists, now),
        fresh: takeNewlyFinished(profileId!, finishedThisYear(mine, now), now.getFullYear()),
      };
    },
  });
}

// v2: from the curated list (v1 held search results).
const GOSKINO_KEY = "martytv.cv.goskino.v2";

/** «Рекомендовано Госкино»: the curated Soviet classics list (titles in the catalog), cached in the browser. */
export function useGoskino(enabled: boolean) {
  const lang = useCatalogLang();
  const cached = enabled ? readCvCache<MediaSummary[]>(GOSKINO_KEY, lang) : null;
  return useQuery({
    queryKey: ["cv", "goskino", lang],
    enabled,
    staleTime: 24 * 3600_000,
    retry: false,
    initialData: cached && cached.length ? cached : undefined,
    queryFn: async () => {
      // No profile_id: the card is the same for everyone and the cache drops `me` anyway.
      const list = await unwrap(api.GET("/curated/{list_id}", { params: { path: { list_id: GOSKINO_LIST_ID }, query: { lang } } }));
      const films = list.items.flatMap((it) => (it.media ? [it.media] : []));
      if (films.length) writeCvCache(GOSKINO_KEY, lang, films.map((f) => ({ ...f, me: undefined })));
      return films;
    },
  });
}

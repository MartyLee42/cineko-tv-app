// «Конструктивизм» always recommends «Ленин в Октябре» (1937): found by a
// catalog search at runtime (no hardcoded id), remembered in the browser.
import { useQuery } from "@tanstack/react-query";
import { unwrap, type MediaSummary } from "@martytv/contracts";
import { LENIN_QUERY, pickLeninInOctober, readLeninCache, writeLeninCache } from "@martytv/ui";
import { api } from "../api";
import { useCatalogLang } from "./queries";

/** The film (null: not found / catalog off). Only queried while `enabled` (the design is on). */
export function useLeninFilm(enabled: boolean) {
  const lang = useCatalogLang();
  const cached = enabled ? readLeninCache<MediaSummary>(lang) : null;
  return useQuery({
    queryKey: ["cv", "lenin", lang],
    enabled,
    queryFn: async (): Promise<MediaSummary | null> => {
      // No profile_id: hide_watched / hide_anime must not filter the recommendation out.
      const page = await unwrap(api.GET("/catalog/search", { params: { query: { q: LENIN_QUERY, kind: "movie", page: 1, lang } } }));
      const hit = pickLeninInOctober(page.items);
      if (hit) writeLeninCache(lang, { ...hit, me: undefined });
      return hit ?? null;
    },
    initialData: cached ?? undefined,
    staleTime: 24 * 3600_000,
    retry: 1,
  });
}

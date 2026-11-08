// Ticket stubs and stickers of the active profile (GET /profiles/{id}/tickets, /achievements).
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { unwrap } from "@martytv/contracts";
import { api } from "../api";
import { useCatalogLang } from "../catalog/queries";
import { useActiveProfile } from "../watch/ActiveProfile";

export function useTickets(limit = 24) {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return useInfiniteQuery({
    queryKey: ["tickets", profileId, lang, limit],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/profiles/{id}/tickets", {
          params: { path: { id: profileId! }, query: { lang, limit, ...(pageParam && { cursor: pageParam }) } },
        }),
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!profileId,
    staleTime: 30_000,
  });
}

export function useAchievements() {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return useQuery({
    queryKey: ["achievements", profileId, lang],
    queryFn: () => unwrap(api.GET("/profiles/{id}/achievements", { params: { path: { id: profileId! }, query: { lang } } })),
    enabled: !!profileId,
    staleTime: 60_000,
  });
}

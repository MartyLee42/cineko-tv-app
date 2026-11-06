// «Новые серии»: the active profile's new episodes (nightly server check).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "@martytv/contracts";
import { api } from "../api";
import { useCatalogLang } from "../catalog/queries";
import { useActiveProfile } from "../watch/ActiveProfile";

export function useNewEpisodes() {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return useQuery({
    queryKey: ["new-episodes", profileId, lang],
    queryFn: () => unwrap(api.GET("/profiles/{id}/new-episodes", { params: { path: { id: profileId! }, query: { lang } } })),
    enabled: !!profileId,
    staleTime: 60_000,
    refetchInterval: 30 * 60_000,
  });
}

export function useMarkNewSeen() {
  const { profileId } = useActiveProfile();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { episode_ids?: string[]; all?: boolean }) => unwrap(api.POST("/profiles/{id}/new-episodes/seen", { params: { path: { id: profileId! } }, body: v })),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["new-episodes"] }),
  });
}

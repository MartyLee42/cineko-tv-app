// «Новые серии»: the active profile's new episodes (nightly server check).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@martytv/contracts";
import { withoutSeries } from "@martytv/media-types";
import { api } from "../api";
import { useCatalogLang } from "../catalog/queries";
import { useActiveProfile } from "../watch/ActiveProfile";

type NewEpisodeList = Schemas["NewEpisodeList"];

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

/** Series the active profile muted (title page toggle, «Скрытые сериалы»). */
export function useMutedSeries() {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return useQuery({
    queryKey: ["new-episodes-muted", profileId, lang],
    queryFn: () => unwrap(api.GET("/profiles/{id}/new-episodes/muted", { params: { path: { id: profileId! }, query: { lang } } })),
    enabled: !!profileId,
    staleTime: 60_000,
  });
}

/** Mute / unmute a series; muting drops its items from the list right away. */
export function useMuteSeries() {
  const { profileId } = useActiveProfile();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ mediaId, on }: { mediaId: string; on: boolean }) => {
      const params = { path: { id: profileId!, mediaId } };
      return on
        ? unwrap(api.PUT("/profiles/{id}/new-episodes/muted/{mediaId}", { params }))
        : unwrap(api.DELETE("/profiles/{id}/new-episodes/muted/{mediaId}", { params }));
    },
    onMutate: async ({ mediaId, on }) => {
      if (!on) return;
      await qc.cancelQueries({ queryKey: ["new-episodes", profileId] });
      qc.setQueriesData<NewEpisodeList>({ queryKey: ["new-episodes", profileId] }, (l) => (l ? withoutSeries(l, mediaId) : l));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["new-episodes"] });
      void qc.invalidateQueries({ queryKey: ["new-episodes-muted"] });
    },
  });
}

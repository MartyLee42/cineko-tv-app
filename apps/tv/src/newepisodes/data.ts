// «Новые серии»: the profile's new episodes (nightly server check) and
// marking them seen. One query feeds the tab badge, the Home row and the screen.
import { useMutation, useQuery } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@martytv/contracts";
import { catalogLang, withoutSeries } from "@martytv/media-types";
import { useI18n } from "@martytv/ui";
import { api } from "../api";
import { queryClient } from "../catalog/queries";
import { useActiveProfileId } from "../profile/active";

export type NewEpisodeItem = Schemas["NewEpisodeItem"];
export type NewEpisodeList = Schemas["NewEpisodeList"];

export const newEpisodesKey = (profile: string | null) => ["new-episodes", profile] as const;

export function useNewEpisodes() {
  const profile = useActiveProfileId();
  const lang = catalogLang(useI18n().locale);
  return useQuery({
    queryKey: [...newEpisodesKey(profile), lang],
    enabled: !!profile,
    staleTime: 5 * 60_000,
    refetchInterval: 30 * 60_000,
    retry: false,
    queryFn: (): Promise<NewEpisodeList> => unwrap(api.GET("/profiles/{id}/new-episodes", { params: { path: { id: profile! }, query: { lang } } })),
  });
}

/** Unseen count for the tab badge (0 while unknown). */
export function useNewEpisodesUnseen(): number {
  return useNewEpisodes().data?.unseen ?? 0;
}

export function useMarkNewSeen() {
  const profile = useActiveProfileId();
  return useMutation({
    mutationFn: (v: { episode_ids?: string[]; all?: boolean }) => unwrap(api.POST("/profiles/{id}/new-episodes/seen", { params: { path: { id: profile! } }, body: v })),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: newEpisodesKey(profile) }),
  });
}

/** «Не уведомлять о сериале»: mutes the series for the profile; its items leave the list at once. */
export function useMuteSeries() {
  const profile = useActiveProfileId();
  return useMutation({
    mutationFn: (mediaId: string) =>
      unwrap(api.PUT("/profiles/{id}/new-episodes/muted/{mediaId}", { params: { path: { id: profile!, mediaId } } })),
    onMutate: (mediaId) => {
      queryClient.setQueriesData<NewEpisodeList>({ queryKey: newEpisodesKey(profile) }, (l) => (l ? withoutSeries(l, mediaId) : l));
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: newEpisodesKey(profile) }),
  });
}

/** After playback / watched marks: the list may have changed. */
export function refreshNewEpisodes() {
  void queryClient.invalidateQueries({ queryKey: ["new-episodes"] });
}

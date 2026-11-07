// «Ранее в сериале» / «После титров» on Details (internal/companion).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, unwrap, type Schemas } from "@martytv/contracts";
import { catalogLang } from "@martytv/media-types";
import { COMPANION_STALE_MS, useI18n, type CompanionTopic } from "@martytv/ui";
import { api } from "../api";

export type MediaCompanion = Schemas["MediaCompanion"];
export type SeriesRecap = Schemas["SeriesRecap"];
export type AfterCredits = Schemas["AfterCredits"];
export type AfterCreditsChat = Schemas["AfterCreditsChat"];

const noRetry = (count: number, err: unknown) => count < 1 && !(err instanceof ApiError && err.status >= 400);

/** Which chips the profile gets; `stamp` (the progress data time) refetches it after watching. */
export function useCompanion(id: string, profileId: string, enabled: boolean, stamp: number) {
  const lang = catalogLang(useI18n().locale);
  return useQuery({
    queryKey: ["companion", id, profileId, lang, stamp],
    enabled,
    staleTime: COMPANION_STALE_MS,
    retry: noRetry,
    queryFn: (): Promise<MediaCompanion> => unwrap(api.GET("/media/{id}/companion", { params: { path: { id }, query: { profile_id: profileId, lang } } })),
  });
}

/** Asked when the panel opens (the server caches it after that). */
export function useRecap(id: string, profileId: string, enabled: boolean) {
  const lang = catalogLang(useI18n().locale);
  return useQuery({
    queryKey: ["companion", id, "recap", profileId, lang],
    enabled,
    staleTime: Infinity,
    retry: noRetry,
    queryFn: (): Promise<SeriesRecap> => unwrap(api.POST("/media/{id}/recap", { params: { path: { id } }, body: { profile_id: profileId, lang } })),
  });
}

export function useAfterCredits(id: string, profileId: string, topic: CompanionTopic, enabled: boolean) {
  const lang = catalogLang(useI18n().locale);
  return useQuery({
    queryKey: ["companion", id, "after", topic, profileId, lang],
    enabled,
    staleTime: Infinity,
    retry: noRetry,
    queryFn: (): Promise<AfterCredits> => unwrap(api.POST("/media/{id}/after-credits", { params: { path: { id } }, body: { profile_id: profileId, lang, topic } })),
  });
}

const chatKey = (id: string, profileId: string, lang: string) => ["companion", id, "chat", profileId, lang];

/** The chat (it may have been started on the phone). */
export function useAfterChat(id: string, profileId: string, enabled: boolean) {
  const lang = catalogLang(useI18n().locale);
  return useQuery({
    queryKey: chatKey(id, profileId, lang),
    enabled,
    retry: noRetry,
    queryFn: (): Promise<AfterCreditsChat> =>
      unwrap(api.GET("/media/{id}/after-credits/chat", { params: { path: { id }, query: { profile_id: profileId, lang } } })),
  });
}

export function useSendChat(id: string, profileId: string) {
  const lang = catalogLang(useI18n().locale);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { message?: string; reset?: boolean }): Promise<AfterCreditsChat> =>
      unwrap(api.POST("/media/{id}/after-credits/chat", { params: { path: { id } }, body: { profile_id: profileId, lang, ...b } })),
    onSuccess: (chat) => qc.setQueryData(chatKey(id, profileId, lang), chat),
  });
}

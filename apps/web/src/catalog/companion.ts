// «Ранее в сериале» / «После титров» on the title page (internal/companion).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, unwrap, type Schemas } from "@martytv/contracts";
import { COMPANION_STALE_MS, type CompanionTopic } from "@martytv/ui";
import { api } from "../api";
import { useCatalogLang } from "./queries";

export type MediaCompanion = Schemas["MediaCompanion"];
export type SeriesRecap = Schemas["SeriesRecap"];
export type AfterCredits = Schemas["AfterCredits"];
export type AfterCreditsChat = Schemas["AfterCreditsChat"];

const noRetry = (count: number, err: unknown) => count < 1 && !(err instanceof ApiError && err.status >= 400);

/** Which buttons the profile gets; `stamp` (progress data time) refetches it after watching. */
export function useCompanion(id: string, profileId: string | null | undefined, stamp: number) {
  const lang = useCatalogLang();
  return useQuery({
    queryKey: ["media", id, "companion", profileId, lang, stamp],
    enabled: !!profileId,
    staleTime: COMPANION_STALE_MS,
    refetchOnWindowFocus: false,
    retry: noRetry,
    queryFn: (): Promise<MediaCompanion> =>
      unwrap(api.GET("/media/{id}/companion", { params: { path: { id }, query: { profile_id: profileId!, lang } } })),
  });
}

/** The recap: asked when the sheet opens (cached server-side afterwards). */
export function useRecap(id: string, profileId: string | null | undefined, enabled: boolean) {
  const lang = useCatalogLang();
  return useQuery({
    queryKey: ["media", id, "recap", profileId, lang],
    enabled: enabled && !!profileId,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: noRetry,
    queryFn: (): Promise<SeriesRecap> => unwrap(api.POST("/media/{id}/recap", { params: { path: { id } }, body: { profile_id: profileId!, lang } })),
  });
}

export function useAfterCredits(id: string, profileId: string | null | undefined, topic: CompanionTopic, enabled: boolean) {
  const lang = useCatalogLang();
  return useQuery({
    queryKey: ["media", id, "after-credits", topic, profileId, lang],
    enabled: enabled && !!profileId,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: noRetry,
    queryFn: (): Promise<AfterCredits> =>
      unwrap(api.POST("/media/{id}/after-credits", { params: { path: { id } }, body: { profile_id: profileId!, lang, topic } })),
  });
}

const chatKey = (id: string, profileId: string | null | undefined, lang: string) => ["media", id, "after-credits-chat", profileId, lang];

export function useAfterChat(id: string, profileId: string | null | undefined, enabled: boolean) {
  const lang = useCatalogLang();
  return useQuery({
    queryKey: chatKey(id, profileId, lang),
    enabled: enabled && !!profileId,
    refetchOnWindowFocus: false,
    retry: noRetry,
    queryFn: (): Promise<AfterCreditsChat> =>
      unwrap(api.GET("/media/{id}/after-credits/chat", { params: { path: { id }, query: { profile_id: profileId!, lang } } })),
  });
}

export function useSendChat(id: string, profileId: string | null | undefined) {
  const lang = useCatalogLang();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { message?: string; reset?: boolean }): Promise<AfterCreditsChat> =>
      unwrap(api.POST("/media/{id}/after-credits/chat", { params: { path: { id } }, body: { profile_id: profileId!, lang, ...b } })),
    onSuccess: (chat) => qc.setQueryData(chatKey(id, profileId, lang), chat),
  });
}

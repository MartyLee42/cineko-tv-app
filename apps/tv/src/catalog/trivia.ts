// «Цитаты» / «Факты» on Details: GET /media/{id}/quotes and /facts.
import { useQuery } from "@tanstack/react-query";
import { unwrap } from "@martytv/contracts";
import { catalogLang } from "@martytv/media-types";
import { TRIVIA_STALE_MS, useI18n, type MediaFacts, type MediaQuotes } from "@martytv/ui";
import { api } from "../api";

export const quotesKey = (id: string, lang: string) => ["media", id, "quotes", lang] as const;
export const factsKey = (id: string, lang: string) => ["media", id, "facts", lang] as const;

/** Prefetched when Details opens: an empty result hides the button. */
export function useQuotes(id: string, enabled: boolean) {
  const lang = catalogLang(useI18n().locale);
  return useQuery({
    queryKey: quotesKey(id, lang),
    enabled,
    staleTime: TRIVIA_STALE_MS,
    gcTime: TRIVIA_STALE_MS,
    queryFn: (): Promise<MediaQuotes> => unwrap(api.GET("/media/{id}/quotes", { params: { path: { id }, query: { lang } } })),
  });
}

/** Loaded when the panel opens (the first call may ask the AI). */
export function useFacts(id: string, enabled: boolean) {
  const lang = catalogLang(useI18n().locale);
  return useQuery({
    queryKey: factsKey(id, lang),
    enabled,
    staleTime: TRIVIA_STALE_MS,
    gcTime: TRIVIA_STALE_MS,
    queryFn: (): Promise<MediaFacts> => unwrap(api.GET("/media/{id}/facts", { params: { path: { id }, query: { lang } } })),
  });
}

// «Цитаты» / «Факты» on the title page: GET /media/{id}/quotes and /facts.
import { useQuery } from "@tanstack/react-query";
import { ApiError, unwrap } from "@martytv/contracts";
import { TRIVIA_STALE_MS, type MediaFacts, type MediaQuotes } from "@martytv/ui";
import { api } from "../api";
import { useCatalogLang } from "./queries";

export const quotesKey = (id: string, lang: string) => ["media", id, "quotes", lang] as const;
export const factsKey = (id: string, lang: string) => ["media", id, "facts", lang] as const;

/** 4xx and «catalog unavailable» (503) won't fix themselves; a network blip may. */
const retry = (count: number, err: unknown) => count < 1 && !(err instanceof ApiError && err.status >= 400);

/** Prefetched with the page: an empty result hides the button. */
export function useQuotes(id: string) {
  const lang = useCatalogLang();
  return useQuery({
    queryKey: quotesKey(id, lang),
    staleTime: TRIVIA_STALE_MS,
    gcTime: TRIVIA_STALE_MS,
    refetchOnWindowFocus: false,
    retry,
    queryFn: (): Promise<MediaQuotes> => unwrap(api.GET("/media/{id}/quotes", { params: { path: { id }, query: { lang } } })),
  });
}

/** Loaded when the sheet opens (the first call may ask the AI). */
export function useFacts(id: string, enabled: boolean) {
  const lang = useCatalogLang();
  return useQuery({
    queryKey: factsKey(id, lang),
    enabled,
    staleTime: TRIVIA_STALE_MS,
    gcTime: TRIVIA_STALE_MS,
    refetchOnWindowFocus: false,
    retry,
    queryFn: (): Promise<MediaFacts> => unwrap(api.GET("/media/{id}/facts", { params: { path: { id }, query: { lang } } })),
  });
}

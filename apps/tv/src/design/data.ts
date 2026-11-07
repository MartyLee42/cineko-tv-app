// Shell data for the designs: server status, clock, unread messages, the
// watchlist ("Моё") and lazily loaded hero details.
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, unwrap, type MediaPage, type Schemas } from "@martytv/contracts";
import { catalogLang } from "@martytv/media-types";
import { useI18n } from "@martytv/ui";
import { api } from "../api";
import { queryClient } from "../catalog/queries";
import { useActiveProfileId } from "../profile/active";
import { patchMeEverywhere } from "../quick/data";

export type Recommendation = Schemas["Recommendation"];

export function useServerStatus() {
  return useQuery({
    queryKey: ["service-status"],
    queryFn: () => unwrap(api.GET("/status")),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });
}

/** The current time, re-rendered every 10 s (the clock shows minutes). */
export function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function useInbox() {
  return useQuery({
    queryKey: ["inbox"],
    queryFn: () => unwrap(api.GET("/messages")),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
}

export function useMarkRead() {
  return useMutation({
    mutationFn: (id: string) => unwrap(api.POST("/messages/{id}/read", { params: { path: { id } } })),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["inbox"] }),
  });
}

export const watchlistKey = (profile: string | null) => ["lists", profile, "watchlist"] as const;

export function useWatchlist() {
  const profile = useActiveProfileId();
  const lang = catalogLang(useI18n().locale);
  return useQuery({
    queryKey: [...watchlistKey(profile), lang],
    enabled: !!profile,
    staleTime: 60_000,
    retry: false,
    queryFn: (): Promise<MediaPage> =>
      unwrap(api.GET("/profiles/{id}/lists/{list}", { params: { path: { id: profile!, list: "watchlist" }, query: { lang, page: 1 } } })),
  });
}

/** Adds/removes a title from the profile's watchlist; refreshes lists and `me`. */
export function useToggleWatchlist() {
  const profile = useActiveProfileId();
  return useMutation({
    mutationFn: ({ mediaId, on }: { mediaId: string; on: boolean }) => {
      const opts = { params: { path: { id: profile!, list: "watchlist" as const, mediaId } } };
      return unwrap(on ? api.PUT("/profiles/{id}/lists/{list}/{mediaId}", opts) : api.DELETE("/profiles/{id}/lists/{list}/{mediaId}", opts));
    },
    // Rows and grids show the change at once (as the quick actions do).
    onMutate: ({ mediaId, on }) => patchMeEverywhere(mediaId, { in_watchlist: on }),
    onError: (_e, { mediaId, on }) => patchMeEverywhere(mediaId, { in_watchlist: !on }),
    onSettled: (_d, _e, { mediaId }) => {
      void queryClient.invalidateQueries({ queryKey: watchlistKey(profile) });
      void queryClient.invalidateQueries({ queryKey: ["media", mediaId] });
    },
  });
}

/** `value` once it stopped changing for `ms` (null meanwhile). */
export function useSettled<T>(value: T, ms: number): T | null {
  const [settled, setSettled] = useState<T | null>(null);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled === value ? settled : null;
}

/** «Советуют близкие»: the owner's inbox. 404 (not deployed yet) → empty. */
export function useRecoInbox() {
  const profile = useActiveProfileId();
  const lang = catalogLang(useI18n().locale);
  return useQuery({
    queryKey: ["reco-inbox", profile, lang],
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
    queryFn: () =>
      unwrap(api.GET("/recommendations/inbox", { params: { query: { lang, ...(profile ? { profile_id: profile } : {}) } } })).catch((e) => {
        if (e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501)) return { items: [] as Recommendation[], unseen: 0 };
        throw e;
      }),
  });
}

/** Marks a recommendation seen (OK on its card / Details opened). */
export function useRecoSeen() {
  return useMutation({
    mutationFn: (id: string) => unwrap(api.PATCH("/recommendations/{id}", { params: { path: { id } }, body: { seen: true } })),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["reco-inbox"] }),
  });
}

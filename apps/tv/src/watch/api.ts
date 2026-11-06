// Watch-progress API: the reporter's transport, Details/Home queries and the
// manual watched toggle. Progress-dependent data is refreshed after a session
// ends so Home and Details show the new position right away.
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, unwrap, type MediaProgress } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";
import { catalogLang } from "@martytv/media-types";
import { api } from "../api";
import { queryClient } from "../catalog/queries";
import { credentialStore } from "../platform";
import { useActiveProfileId } from "../profile/active";
import type { ReportBody, SessionStart, SessionTarget, Transport } from "./reporter";

const progressUrl = (id: string) => `/api/v1/playback/sessions/${encodeURIComponent(id)}/progress`;

/**
 * Reports go through the API client (bearer auth). On page hide we can't
 * wait for an answer: navigator.sendBeacon with the session's report token
 * (`?token=`, text/plain JSON — sendBeacon can't set headers and the TV has
 * no cookie) survives unload; without it (or if the beacon is refused),
 * `fetch(…, {keepalive: true})` with the Authorization header. Engines
 * without keepalive still send that request but may cancel it on unload.
 */
export const apiTransport: Transport = {
  start: (t: SessionTarget) => {
    const body: { profile_id: string; media_id: string; episode_id?: string; source_id?: string } = { profile_id: t.profile_id, media_id: t.media_id };
    if (t.episode_id) body.episode_id = t.episode_id;
    if (t.source_id) body.source_id = t.source_id;
    return unwrap(api.POST("/playback/sessions", { body })) as Promise<SessionStart>;
  },
  report: (id: string, body: ReportBody) => unwrap(api.POST("/playback/sessions/{id}/progress", { params: { path: { id } }, body })),
  beacon: (id: string, body: ReportBody, token: string | null) => {
    const json = JSON.stringify(body);
    if (token && typeof navigator.sendBeacon === "function") {
      try {
        if (navigator.sendBeacon(`${progressUrl(id)}?token=${encodeURIComponent(token)}`, new Blob([json], { type: "text/plain" }))) return;
      } catch {
        // fall through
      }
    }
    const bearer = credentialStore.get();
    if (!bearer || typeof fetch !== "function") return;
    try {
      void fetch(progressUrl(id), {
        method: "POST",
        keepalive: true,
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: json,
      }).catch(() => undefined);
    } catch {
      // nothing else to try
    }
  },
};

export const mediaProgressKey = (mediaId: string, profile: string | null) => ["watch", "media", mediaId, profile] as const;
export const continueKey = (profile: string | null, lang: string) => ["watch", "continue", profile, lang] as const;

/** 404 = no progress API yet / nothing known: treated as "no progress". */
function orNull<T>(p: Promise<T>): Promise<T | null> {
  return p.catch((e) => {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501)) return null;
    throw e;
  });
}

export function useMediaProgress(mediaId: string) {
  const profile = useActiveProfileId();
  const lang = catalogLang(useI18n().locale);
  return useQuery({
    queryKey: [...mediaProgressKey(mediaId, profile), lang],
    enabled: !!profile,
    staleTime: 30_000,
    retry: false,
    queryFn: () => orNull(unwrap(api.GET("/media/{id}/progress", { params: { path: { id: mediaId }, query: { profile_id: profile!, lang } } }))),
  });
}

export function useContinueWatching() {
  const profile = useActiveProfileId();
  const lang = catalogLang(useI18n().locale);
  return useQuery({
    queryKey: continueKey(profile, lang),
    enabled: !!profile,
    staleTime: 60_000,
    retry: false,
    queryFn: () =>
      orNull(unwrap(api.GET("/profiles/{id}/continue-watching", { params: { path: { id: profile! }, query: { lang } } }))).then(
        (r) => r?.items ?? [],
      ),
  });
}

/** Marks a movie / an episode / a whole season watched or unwatched. */
export function useSetWatched(mediaId: string) {
  const profile = useActiveProfileId();
  const lang = catalogLang(useI18n().locale);
  return useMutation({
    mutationFn: (v: { watched: boolean; episode_id?: string; season_number?: number }) =>
      unwrap(api.PUT("/media/{id}/watched", { params: { path: { id: mediaId }, query: { lang } }, body: { profile_id: profile!, ...v } })),
    onSuccess: (mp: MediaProgress) => {
      queryClient.setQueryData([...mediaProgressKey(mediaId, profile), lang], mp);
      refreshWatchData(false);
    },
  });
}

/**
 * After playback / a watched change: Home's continue row, `me` badges in
 * lists and progress on Details are stale. `details` false keeps the
 * Details progress (it was just set from the answer).
 */
export function refreshWatchData(details = true) {
  void queryClient.invalidateQueries({ queryKey: ["watch", "continue"] });
  // «Новые серии»: watching an episode marks it seen.
  void queryClient.invalidateQueries({ queryKey: ["new-episodes"] });
  if (details) void queryClient.invalidateQueries({ queryKey: ["watch", "media"] });
  void queryClient.invalidateQueries({ queryKey: ["catalog"], refetchType: "active" });
  void queryClient.invalidateQueries({ queryKey: ["related"], refetchType: "active" });
}

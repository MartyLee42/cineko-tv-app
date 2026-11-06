// Phase 6 data: «Для вас» rows + feedback, Explore / browse tiles, AI
// collections, Surprise me, Diary, Taste DNA, admin rerun.
import { useEffect } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError, unwrap, type MediaKind, type Schemas } from "@martytv/contracts";
import { withoutMedia, type SurpriseRequestBody } from "@martytv/ui";
import { api, realtime } from "../api";
import { useCatalogLang } from "../catalog/queries";
import { useActiveProfile } from "../watch/ActiveProfile";
import { FeedbackQueue, type FeedbackAction } from "./logic";
import { patchMe } from "../watch/queries";

export type ForYouRows = Schemas["ForYouRows"];
export type ForYouRow = Schemas["ForYouRow"];
export type ForYouItem = Schemas["ForYouItem"];
export type ExploreSection = Schemas["ExploreSection"];
export type ExploreTile = Schemas["ExploreTile"];
export type ForYouCollection = Schemas["ForYouCollection"];
export type SurpriseResult = Schemas["SurpriseResult"];
export type ForYouRun = Schemas["ForYouRun"];
export type Diary = Schemas["Diary"];
export type TasteDNA = Schemas["TasteDNA"];
export type CuratedGroup = Schemas["CuratedGroup"];
export type CuratedListSummary = Schemas["CuratedListSummary"];
export type CuratedList = Schemas["CuratedList"];
export type CuratedItem = Schemas["CuratedItem"];

export const rowsKey = (profileId: string | undefined, lang: string) => ["foryou", "rows", profileId, lang] as const;

export function useForYouRows() {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return useQuery({
    queryKey: rowsKey(profileId, lang),
    queryFn: () => unwrap(api.GET("/foryou/rows", { params: { query: { profile_id: profileId!, lang } } })),
    enabled: !!profileId,
    staleTime: 5 * 60_000,
    // A rebuild is running: look again shortly (the realtime event usually comes first).
    refetchInterval: (q) => (q.state.data?.stale ? 20_000 : false),
  });
}

// ---------------------------------------------------------------- feedback (batched)

const queue = new FeedbackQueue();
let timer: ReturnType<typeof setTimeout> | undefined;
let flushProfile: string | undefined;

function flushSoon(ms: number) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    flushNow();
  }, ms);
}

export function flushNow() {
  const profile = flushProfile;
  if (!profile) return;
  while (queue.size) {
    const events = queue.flush(100);
    void api.POST("/foryou/feedback", { body: { profile_id: profile, events } }).catch(() => undefined);
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushNow);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushNow());
}

/** Queues feedback for the active profile (impressions deduped; flushed every few seconds or at 100). */
export function sendFeedback(profileId: string | undefined, mediaId: string, action: FeedbackAction, rowId?: string) {
  if (!profileId) return;
  if (flushProfile && flushProfile !== profileId) flushNow();
  flushProfile = profileId;
  queue.add({ media_id: mediaId, action, ...(rowId && { row_id: rowId.slice(0, 80) }) });
  if (queue.size >= 100) flushNow();
  else flushSoon(action === "impression" ? 4000 : 800);
}

export function useFeedback() {
  const { profileId } = useActiveProfile();
  return (mediaId: string, action: FeedbackAction, rowId?: string) => sendFeedback(profileId, mediaId, action, rowId);
}

/** «Не интересно»: removes the title from every cached row at once, sent right away; undo restores. */
export function useDismiss() {
  const qc = useQueryClient();
  const { profileId } = useActiveProfile();
  return useMutation({
    mutationFn: ({ mediaId, rowId, undo }: { mediaId: string; rowId?: string; undo?: boolean }) =>
      unwrap(
        api.POST("/foryou/feedback", {
          body: { profile_id: profileId!, media_id: mediaId, action: undo ? "undismiss" : "dismiss", ...(rowId && { row_id: rowId.slice(0, 80) }) },
        }),
      ),
    onMutate: async ({ mediaId, undo }) => {
      if (undo) return { prev: [] as [readonly unknown[], ForYouRows | undefined][] };
      await qc.cancelQueries({ queryKey: ["foryou", "rows", profileId] });
      const prev = qc.getQueriesData<ForYouRows>({ queryKey: ["foryou", "rows", profileId] });
      qc.setQueriesData<ForYouRows>({ queryKey: ["foryou", "rows", profileId] }, (d) => (d ? { ...d, rows: withoutMedia(d.rows, mediaId) } : d));
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev.forEach(([k, d]) => qc.setQueryData(k, d)),
    onSuccess: (_d, { undo }) => {
      if (undo) void qc.invalidateQueries({ queryKey: ["foryou", "rows", profileId] });
    },
  });
}

// ---------------------------------------------------------------- explore / browse / collections

export function useExplore() {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return useQuery({
    queryKey: ["foryou", "explore", profileId, lang],
    queryFn: async () => (await unwrap(api.GET("/foryou/explore", { params: { query: { profile_id: profileId!, lang } } }))).sections,
    enabled: !!profileId,
    staleTime: 10 * 60_000,
  });
}

export function useBrowseTile(tile: string, kind: MediaKind | undefined) {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return useInfiniteQuery({
    queryKey: ["foryou", "browse", tile, kind, profileId, lang],
    queryFn: ({ pageParam }) =>
      unwrap(api.GET("/foryou/browse", { params: { query: { tile, profile_id: profileId!, lang, page: pageParam, ...(kind && { kind }) } } })),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < Math.min(last.total_pages, 500) ? last.page + 1 : undefined),
    enabled: !!profileId && !!tile,
  });
}

export function useCollections() {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return useQuery({
    queryKey: ["foryou", "collections", profileId, lang],
    queryFn: () => unwrap(api.GET("/foryou/collections", { params: { query: { profile_id: profileId!, lang } } })),
    enabled: !!profileId,
    staleTime: 10 * 60_000,
  });
}

export function useCollection(id: string) {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return useQuery({
    queryKey: ["foryou", "collection", id, profileId, lang],
    queryFn: () => unwrap(api.GET("/foryou/collections/{id}", { params: { path: { id }, query: { profile_id: profileId!, lang } } })),
    enabled: !!profileId && !!id,
  });
}

// ---------------------------------------------------------------- curated lists («Подборки»)

/** The shelf: lists by group, with the profile's watched counts. */
export function useCuratedLists() {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return useQuery({
    queryKey: ["foryou", "curated", profileId, lang],
    queryFn: async () => (await unwrap(api.GET("/curated", { params: { query: { profile_id: profileId!, lang } } }))).groups,
    enabled: !!profileId,
    staleTime: 5 * 60_000,
  });
}

export function useCuratedList(id: string) {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return useQuery({
    queryKey: ["foryou", "curated", profileId, lang, id],
    queryFn: () => unwrap(api.GET("/curated/{list_id}", { params: { path: { list_id: id }, query: { profile_id: profileId!, lang } } })),
    enabled: !!profileId && !!id,
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------- surprise

export function useSurpriseOptions() {
  const lang = useCatalogLang();
  return useQuery({
    queryKey: ["foryou", "surprise-options", lang],
    queryFn: () => unwrap(api.GET("/foryou/surprise/options", { params: { query: { lang } } })),
    staleTime: Infinity,
  });
}

export function useSurprise() {
  const lang = useCatalogLang();
  return useMutation({
    mutationFn: (body: SurpriseRequestBody) => unwrap(api.POST("/foryou/surprise", { params: { query: { lang } }, body: { include_watched: false, kind: "movie", ...body } })),
  });
}

// ---------------------------------------------------------------- diary / taste

export function useDiary(month: string) {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return useQuery({
    queryKey: ["foryou", "diary", profileId, month, lang],
    queryFn: () => unwrap(api.GET("/profiles/{id}/diary", { params: { path: { id: profileId! }, query: { month, lang } } })),
    enabled: !!profileId,
    staleTime: 60_000,
  });
}

export function useTaste() {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return useQuery({
    queryKey: ["foryou", "taste", profileId, lang],
    queryFn: () => unwrap(api.GET("/profiles/{id}/taste", { params: { path: { id: profileId! }, query: { lang } } })),
    enabled: !!profileId,
    staleTime: 5 * 60_000,
  });
}

// ---------------------------------------------------------------- admin

export function useForYouRuns(poll: boolean) {
  return useQuery({
    queryKey: ["admin", "foryou-runs"],
    queryFn: () => unwrap(api.GET("/admin/foryou/runs")),
    refetchInterval: poll ? 2000 : 30_000,
  });
}

export type RerunBody = { scope: "all" | "user" | "profile"; id?: string; ai: boolean };

/** Starts a run; a 409 resolves with `{ running: run_id }` instead of throwing. */
export function useRerun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: RerunBody): Promise<{ run_id: string; already: boolean }> => {
      try {
        const r = await unwrap(api.POST("/admin/foryou/rerun", { body }));
        return { run_id: r.run_id, already: false };
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) return { run_id: "", already: true };
        throw e;
      }
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["admin", "foryou-runs"] }),
  });
}

// ---------------------------------------------------------------- manual AI regeneration

export type RegenStatus = Schemas["ForYouRegenStatus"];

export function useRegenStatus() {
  const { profileId } = useActiveProfile();
  return useQuery({
    queryKey: ["foryou", "regen", profileId],
    queryFn: () => unwrap(api.GET("/foryou/regenerate", { params: { query: { profile_id: profileId! } } })),
    enabled: !!profileId,
    staleTime: 60_000,
    // While running, poll until it ends (foryou.updated usually comes first).
    refetchInterval: (q) => (q.state.data?.running ? 3_000 : false),
  });
}

/** «Обновить подборки ИИ»: starts the profile's regeneration (once a day). */
export function useRegenerate() {
  const qc = useQueryClient();
  const { profileId } = useActiveProfile();
  return useMutation({
    mutationFn: () => unwrap(api.POST("/foryou/regenerate", { body: { profile_id: profileId! } })),
    onSuccess: (st) => qc.setQueryData(["foryou", "regen", profileId], st),
    onError: () => void qc.invalidateQueries({ queryKey: ["foryou", "regen", profileId] }),
  });
}

// ---------------------------------------------------------------- personal notes

/** Saves (or, empty, deletes) the profile's note on a title; `me.note` is patched everywhere. */
export function useSaveNote() {
  const qc = useQueryClient();
  const { profileId } = useActiveProfile();
  return useMutation({
    mutationFn: async ({ mediaId, text, reasons }: { mediaId: string; text: string; reasons: Schemas["NoteReason"][] }) => {
      const path = { id: profileId!, mediaId };
      const res = await api.PUT("/profiles/{id}/notes/{mediaId}", { params: { path }, body: { text, reasons } });
      if (res.response.status === 204) return null;
      const saved = (await unwrap(Promise.resolve(res))) as Schemas["MediaNoteSaved"];
      return { text: saved.text, reasons: saved.reasons };
    },
    onSuccess: (note, { mediaId }) => {
      patchMe(qc, mediaId, { note });
      void qc.invalidateQueries({ queryKey: ["notes"] });
    },
  });
}

export function useNotes() {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return useInfiniteQuery({
    queryKey: ["notes", profileId, lang],
    enabled: !!profileId,
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      unwrap(api.GET("/profiles/{id}/notes", { params: { path: { id: profileId! }, query: { lang, ...(pageParam && { cursor: pageParam }) } } })),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

// ---------------------------------------------------------------- realtime

/** `foryou.updated`: refetch rows / collections (and taste) of the affected profiles. */
export function applyForYouEvent(qc: QueryClient, type: string) {
  if (type !== "foryou.updated") return;
  void qc.invalidateQueries({ queryKey: ["foryou", "rows"] });
  void qc.invalidateQueries({ queryKey: ["foryou", "collections"] });
  void qc.invalidateQueries({ queryKey: ["foryou", "explore"] });
  void qc.invalidateQueries({ queryKey: ["foryou", "taste"] });
  void qc.invalidateQueries({ queryKey: ["foryou", "regen"] });
}

// ---------------------------------------------------------------- play tracking

/** Titles opened from a «Для вас» surface recently: media id → row id (for `play`). */
const opened = new Map<string, { row: string; profile: string; at: number }>();
const OPEN_TTL = 6 * 3600_000;

/** Remembers that a recommendation was opened (and sends `open`). */
export function trackOpen(profileId: string | undefined, mediaId: string, rowId: string) {
  if (!profileId) return;
  opened.set(mediaId, { row: rowId, profile: profileId, at: Date.now() });
  sendFeedback(profileId, mediaId, "open", rowId);
}

/** Sends `play` once for a title opened from a recommendation. */
export function trackPlay(mediaId: string | null | undefined) {
  if (!mediaId) return;
  const o = opened.get(mediaId);
  if (!o || Date.now() - o.at > OPEN_TTL) return;
  opened.delete(mediaId);
  sendFeedback(o.profile, mediaId, "play", o.row);
}

/**
 * Realtime `foryou.updated` → refetch; playback of a recommended title (here:
 * the /watch page; on a TV: its device.state) → `play` feedback.
 */
export function useForYouRealtime(enabled: boolean, pathname: string, search: string) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    return realtime.on((env) => {
      applyForYouEvent(qc, env.type);
      if (env.type === "device.state") {
        const st = env.payload as { media_id?: string | null; playback?: { state?: string } | null } | undefined;
        if (st?.playback?.state === "playing") trackPlay(st.media_id);
      }
    });
  }, [qc, enabled]);
  useEffect(() => {
    if (pathname.startsWith("/watch/")) trackPlay(new URLSearchParams(search).get("media"));
  }, [pathname, search]);
}

// ---------------------------------------------------------------- ask AI («Спросить ИИ»)

export type ForYouAsk = Schemas["ForYouAsk"];
export type ForYouAskBody = Schemas["ForYouAskRequest"];

export const asksKey = (profileId: string | undefined, lang: string) => ["foryou", "asks", profileId, lang] as const;

/** The profile's last asks (reopened without a new model call). */
export function useAskHistory(profileId: string | undefined) {
  const lang = useCatalogLang();
  return useQuery({
    queryKey: asksKey(profileId, lang),
    queryFn: () => unwrap(api.GET("/foryou/asks", { params: { query: { profile_id: profileId!, lang } } })),
    enabled: !!profileId,
  });
}

/** POST /foryou/ask; the answer is prepended to the cached history. */
export function useAsk() {
  const qc = useQueryClient();
  const lang = useCatalogLang();
  return useMutation({
    mutationFn: (body: ForYouAskBody) => unwrap(api.POST("/foryou/ask", { params: { query: { lang } }, body })),
    onSuccess: (res, body) => {
      qc.setQueriesData<{ items: ForYouAsk[]; ai_enabled: boolean; daily_limit: number }>({ queryKey: ["foryou", "asks", body.profile_id] }, (d) =>
        d ? { ...d, items: [res, ...d.items.filter((a) => a.id !== res.id)].slice(0, 20) } : d,
      );
    },
  });
}

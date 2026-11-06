// Phase 6 data for the TV: «Для вас» rows, Explore, tile/collection titles,
// «Удиви меня!», History and batched feedback. Profile-scoped keys start
// with "foryou" so a realtime `foryou.updated` refreshes them all at once.
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, unwrap, type Schemas } from "@martytv/contracts";
import { catalogLang } from "@martytv/media-types";
import { useI18n, withoutMedia, type SurpriseRequestBody } from "@martytv/ui";
import { api } from "../api";
import { queryClient } from "../catalog/queries";
import { uniqueById } from "../catalog/focusKeys";
import { activeProfile, useActiveProfileId } from "../profile/active";

export type ForYouRows = Schemas["ForYouRows"];
export type ForYouRow = Schemas["ForYouRow"];
export type ForYouItem = Schemas["ForYouItem"];
export type ExploreSection = Schemas["ExploreSection"];
export type ExploreTile = Schemas["ExploreTile"];
export type ForYouCollection = Schemas["ForYouCollection"];
export type SurpriseResult = Schemas["SurpriseResult"];
export type MoodOption = Schemas["ForYouMoodOption"];
export type FeedbackAction = Schemas["ForYouFeedbackAction"];

const useLang = () => catalogLang(useI18n().locale);
const missing = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501);

export const rowsKey = (profile: string | null, lang: string) => ["foryou", "rows", profile, lang] as const;

/** «Для вас» rows. A server without Phase 6 (404) → no rows. */
export function useForYouRows() {
  const profile = useActiveProfileId();
  const lang = useLang();
  return useQuery({
    queryKey: rowsKey(profile, lang),
    enabled: !!profile,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: (): Promise<ForYouRows> =>
      unwrap(api.GET("/foryou/rows", { params: { query: { profile_id: profile!, lang } } })).catch((e) => {
        if (missing(e)) return { profile_id: profile!, generated_at: null, stale: false, cold_start: true, rows: [] };
        throw e;
      }),
  });
}

export function useExplore() {
  const profile = useActiveProfileId();
  const lang = useLang();
  return useQuery({
    queryKey: ["foryou", "explore", profile, lang],
    enabled: !!profile,
    staleTime: 10 * 60_000,
    queryFn: () => unwrap(api.GET("/foryou/explore", { params: { query: { profile_id: profile!, lang } } })),
  });
}

/** Titles of one Explore tile, page by page. */
export function useTileBrowse(tile: string) {
  const profile = useActiveProfileId();
  const lang = useLang();
  const q = useInfiniteQuery({
    queryKey: ["foryou", "browse", tile, profile, lang],
    enabled: !!profile,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => unwrap(api.GET("/foryou/browse", { params: { query: { tile, profile_id: profile!, lang, page: pageParam } } })),
    getNextPageParam: (last) => (last.page < last.total_pages ? last.page + 1 : undefined),
  });
  const pages = q.data?.pages ?? [];
  return { ...q, items: uniqueById(pages.flatMap((p) => p.items)), total: pages[0]?.total_results ?? 0, title: pages[0]?.title ?? null };
}

export function useCollection(id: string) {
  const profile = useActiveProfileId();
  const lang = useLang();
  return useQuery({
    queryKey: ["foryou", "collection", id, profile, lang],
    enabled: !!profile,
    retry: false,
    queryFn: () => unwrap(api.GET("/foryou/collections/{id}", { params: { path: { id }, query: { profile_id: profile!, lang } } })),
  });
}

/** A curated list («Подборки»: Делёз, Госкино…) with the profile's ✓ marks. */
export function useCurated(id: string) {
  const profile = useActiveProfileId();
  const lang = useLang();
  return useQuery({
    queryKey: ["foryou", "curated", id, profile, lang],
    enabled: !!profile,
    retry: false,
    queryFn: () => unwrap(api.GET("/curated/{list_id}", { params: { path: { list_id: id }, query: { profile_id: profile!, lang } } })),
  });
}

export function useSurpriseOptions() {
  const lang = useLang();
  return useQuery({
    queryKey: ["foryou", "surprise-options", lang],
    staleTime: Infinity,
    queryFn: () => unwrap(api.GET("/foryou/surprise/options", { params: { query: { lang } } })),
  });
}

export function useSurprise() {
  const lang = useLang();
  return useMutation({
    // include_watched/kind have server defaults; the helper sends them only when set.
    mutationFn: (body: SurpriseRequestBody) => unwrap(api.POST("/foryou/surprise", { params: { query: { lang } }, body: body as Schemas["SurpriseRequest"] })),
  });
}

export type HistoryPage = Schemas["HistoryItem"][];

/** Watch history of the profile, newest first (100 per page). 404 → empty. */
export function useHistory() {
  const profile = useActiveProfileId();
  const lang = useLang();
  return useInfiniteQuery({
    queryKey: ["foryou", "history", profile, lang],
    enabled: !!profile,
    staleTime: 60_000,
    retry: false,
    initialPageParam: "",
    queryFn: ({ pageParam }) =>
      unwrap(api.GET("/profiles/{id}/history", { params: { path: { id: profile! }, query: { lang, limit: 100, ...(pageParam ? { cursor: pageParam } : {}) } } })).catch((e) => {
        if (missing(e)) return { items: [], next_cursor: null };
        throw e;
      }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

/** Refetch everything profile-scoped after `foryou.updated` (and the history after playback). */
export function invalidateForYou() {
  void queryClient.invalidateQueries({ queryKey: ["foryou"] });
}

// ---------------------------------------------------------------- feedback

interface Pending {
  media_id: string;
  action: FeedbackAction;
  row_id?: string;
}

const FLUSH_MS = 4000;
const MAX_BATCH = 100;
let queue: Pending[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
/** Rows whose impressions were already sent in this app run. */
const impressed = new Set<string>();

export function flushFeedback() {
  clearTimeout(timer);
  timer = undefined;
  const profile = activeProfile.get();
  const events = queue;
  queue = [];
  if (!profile || events.length === 0) return;
  void api.POST("/foryou/feedback", { body: { profile_id: profile, events } }).catch(() => undefined);
}

/** Queues one event; sent in batches (every few seconds, or at 100 events). */
export function track(mediaId: string, action: FeedbackAction, rowId?: string) {
  queue.push(rowId ? { media_id: mediaId, action, row_id: rowId.slice(0, 80) } : { media_id: mediaId, action });
  if (queue.length >= MAX_BATCH) return flushFeedback();
  if (!timer) timer = setTimeout(flushFeedback, FLUSH_MS);
}

/** Impressions for the first cards of a row, once per row and profile. */
export function trackImpressions(rowId: string, mediaIds: string[], count = 8) {
  const k = `${activeProfile.get()}:${rowId}`;
  if (impressed.has(k)) return;
  impressed.add(k);
  for (const id of mediaIds.slice(0, count)) track(id, "impression", rowId);
}

/** «Не интересно»: sent right away, and the title leaves every cached row. */
export function dismiss(mediaId: string, rowId?: string) {
  const profile = activeProfile.get();
  if (!profile) return;
  queryClient.setQueriesData<ForYouRows>({ queryKey: ["foryou", "rows", profile] }, (d) => (d ? { ...d, rows: withoutMedia(d.rows, mediaId) } : d));
  void api
    .POST("/foryou/feedback", { body: { profile_id: profile, media_id: mediaId, action: "dismiss", ...(rowId ? { row_id: rowId.slice(0, 80) } : {}) } })
    .catch(() => undefined);
}

if (typeof window !== "undefined") window.addEventListener("pagehide", flushFeedback);

// ---------------------------------------------------------------- personal notes

export type NoteReason = Schemas["NoteReason"];
export const DISLIKE_REASONS: NoteReason[] = ["too_slow", "too_scary", "too_violent", "boring_plot", "bad_acting", "not_my_genre", "already_seen", "bad_ending", "too_long", "childish"];

/** Saves the profile's note on a title («Почему?» after «Не интересно»); empty → nothing sent. */
export async function saveNote(mediaId: string, text: string, reasons: NoteReason[]): Promise<boolean> {
  const profile = activeProfile.get();
  const body = { text: text.trim(), reasons: [...new Set(reasons)] };
  if (!profile || (!body.text && !body.reasons.length)) return false;
  const res = await api.PUT("/profiles/{id}/notes/{mediaId}", { params: { path: { id: profile, mediaId } }, body });
  if (res.error) return false;
  // `me.note` shows on Details: refresh cached copies of the title.
  void queryClient.invalidateQueries({ queryKey: ["media", mediaId] });
  return true;
}

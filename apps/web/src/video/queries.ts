// «Видео» data: catalog (search, trending, video, channel), the profile's
// lists (feed, subscriptions, watch later, history, continue), toggles,
// playback sources, progress reports and the admin Invidious status.
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError, unwrap, type Schemas } from "@martytv/contracts";
import { api } from "../api";
import { useActiveProfile } from "../watch/ActiveProfile";
import { channelNextPage, FEED_PAGE, feedNextOffset, isVideoUnavailable, searchNextPage } from "./logic";

export type VideoDetail = Schemas["VideoDetail"];
export type VideoChannel = Schemas["VideoChannel"];
export type VideoChannelRef = Schemas["VideoChannelRef"];
export type VideoSearchResult = Schemas["VideoSearchResult"];
export type AdminVideoStatus = Schemas["AdminVideoStatus"];

export const videoKey = ["video"] as const;

// 503 video_unavailable: don't hammer a service that is down.
const retry = (count: number, err: unknown) => !isVideoUnavailable(err) && !(err instanceof ApiError && err.status < 500) && count < 2;

const pid = (profileId: string | undefined) => (profileId ? { profile_id: profileId } : {});

/** «Подписки»: the subscribed channels' latest uploads, a page (FEED_PAGE) at a time. */
export function useFeed() {
  const { profileId } = useActiveProfile();
  return useInfiniteQuery({
    queryKey: ["video", "feed", profileId ?? ""],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      unwrap(api.GET("/video/feed", { params: { query: { profile_id: profileId!, offset: pageParam, limit: FEED_PAGE } } })),
    getNextPageParam: (last) => feedNextOffset(last),
    enabled: !!profileId,
    retry,
  });
}

export function useSubscriptions() {
  const { profileId } = useActiveProfile();
  return useQuery({
    queryKey: ["video", "subscriptions", profileId ?? ""],
    queryFn: () => unwrap(api.GET("/video/subscriptions", { params: { query: { profile_id: profileId! } } })).then((r) => r.items),
    enabled: !!profileId,
    retry,
  });
}

export function useTrending() {
  const { profileId } = useActiveProfile();
  return useQuery({
    queryKey: ["video", "trending", profileId ?? ""],
    queryFn: () => unwrap(api.GET("/video/trending", { params: { query: { region: "RU", ...pid(profileId) } } })).then((r) => r.items),
    staleTime: 5 * 60_000,
    retry,
  });
}

export function useWatchLater() {
  const { profileId } = useActiveProfile();
  return useQuery({
    queryKey: ["video", "watch-later", profileId ?? ""],
    queryFn: () => unwrap(api.GET("/video/watch-later", { params: { query: { profile_id: profileId! } } })).then((r) => r.items),
    enabled: !!profileId,
    retry,
  });
}

export function useVideoHistory() {
  const { profileId } = useActiveProfile();
  return useQuery({
    queryKey: ["video", "history", profileId ?? ""],
    queryFn: () => unwrap(api.GET("/video/history", { params: { query: { profile_id: profileId! } } })).then((r) => r.items),
    enabled: !!profileId,
    retry,
  });
}

/** «Продолжить»: unfinished videos. */
export function useContinue() {
  const { profileId } = useActiveProfile();
  return useQuery({
    queryKey: ["video", "continue", profileId ?? ""],
    queryFn: () => unwrap(api.GET("/video/continue", { params: { query: { profile_id: profileId! } } })).then((r) => r.items),
    enabled: !!profileId,
    retry,
  });
}

export const SEARCH_PAGES = 20;

export function useVideoSearch(q: string) {
  const { profileId } = useActiveProfile();
  return useInfiniteQuery({
    queryKey: ["video", "search", profileId ?? "", q],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => unwrap(api.GET("/video/search", { params: { query: { q, page: pageParam, ...pid(profileId) } } })),
    getNextPageParam: (last) => searchNextPage(last, SEARCH_PAGES),
    enabled: q.trim().length > 0,
    staleTime: 5 * 60_000,
    retry,
  });
}

export function useSuggestions(q: string) {
  return useQuery({
    queryKey: ["video", "suggestions", q],
    queryFn: () => unwrap(api.GET("/video/search/suggestions", { params: { query: { q } } })).then((r) => r.items),
    enabled: q.trim().length > 0,
    staleTime: 60 * 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

const detailKey = (id: string, profileId: string | undefined) => ["video", "video", id, profileId ?? ""] as const;
const channelKey = (id: string, profileId: string | undefined) => ["video", "channel", id, profileId ?? ""] as const;

export function useVideoDetail(id: string) {
  const { profileId } = useActiveProfile();
  return useQuery({
    queryKey: detailKey(id, profileId),
    queryFn: () => unwrap(api.GET("/video/videos/{video_id}", { params: { path: { video_id: id }, query: pid(profileId) } })),
    staleTime: 5 * 60_000,
    retry,
  });
}

export function useVideoChannel(id: string) {
  const { profileId } = useActiveProfile();
  return useQuery({
    queryKey: channelKey(id, profileId),
    queryFn: () => unwrap(api.GET("/video/channels/{channel_id}", { params: { path: { channel_id: id }, query: pid(profileId) } })),
    staleTime: 5 * 60_000,
    retry,
  });
}

/** A channel's uploads after the first page (the channel page itself has the first). */
export function useChannelMore(id: string, first: string | null | undefined, started: boolean) {
  const { profileId } = useActiveProfile();
  return useInfiniteQuery({
    queryKey: ["video", "channel-videos", id, profileId ?? "", first ?? ""],
    initialPageParam: first ?? "",
    queryFn: ({ pageParam }) => fetchChannelVideos(id, pageParam, profileId),
    getNextPageParam: (last) => channelNextPage(last),
    enabled: started && !!first,
    staleTime: 5 * 60_000,
    retry,
  });
}

export function fetchChannelVideos(channelId: string, continuation: string, profileId: string | undefined) {
  return unwrap(api.GET("/video/channels/{channel_id}/videos", { params: { path: { channel_id: channelId }, query: { continuation, ...pid(profileId) } } }));
}

/** Patches `subscribed` for a channel in every cached video detail / channel page. */
function patchSubscribed(qc: QueryClient, channelId: string, subscribed: boolean) {
  qc.setQueriesData<VideoDetail>({ queryKey: ["video", "video"] }, (old) =>
    old && old.channel.id === channelId ? { ...old, channel: { ...old.channel, subscribed } } : old,
  );
  qc.setQueriesData<VideoChannel>({ queryKey: ["video", "channel", channelId] }, (old) => (old ? { ...old, subscribed } : old));
}

/** Subscribe / unsubscribe (optimistic). */
export function useSubscribe() {
  const qc = useQueryClient();
  const { profileId } = useActiveProfile();
  return useMutation({
    mutationFn: async ({ channelId, on }: { channelId: string; on: boolean }) => {
      const params = { path: { channel_id: channelId }, query: { profile_id: profileId! } };
      if (on) await unwrap(api.PUT("/video/subscriptions/{channel_id}", { params }));
      else await unwrap(api.DELETE("/video/subscriptions/{channel_id}", { params }));
    },
    onMutate: ({ channelId, on }) => patchSubscribed(qc, channelId, on),
    onError: (_e, { channelId, on }) => patchSubscribed(qc, channelId, !on),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["video", "feed"] });
      void qc.invalidateQueries({ queryKey: ["video", "subscriptions"] });
      void qc.invalidateQueries({ queryKey: ["video", "search"] });
    },
  });
}

function patchWatchLater(qc: QueryClient, videoId: string, on: boolean) {
  qc.setQueriesData<VideoDetail>({ queryKey: ["video", "video", videoId] }, (old) => (old ? { ...old, in_watch_later: on } : old));
}

/** «Смотреть позже» add / remove (optimistic). */
export function useWatchLaterToggle() {
  const qc = useQueryClient();
  const { profileId } = useActiveProfile();
  return useMutation({
    mutationFn: async ({ videoId, on }: { videoId: string; on: boolean }) => {
      const params = { path: { video_id: videoId }, query: { profile_id: profileId! } };
      if (on) await unwrap(api.PUT("/video/watch-later/{video_id}", { params }));
      else await unwrap(api.DELETE("/video/watch-later/{video_id}", { params }));
    },
    onMutate: ({ videoId, on }) => patchWatchLater(qc, videoId, on),
    onError: (_e, { videoId, on }) => patchWatchLater(qc, videoId, !on),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["video", "watch-later"] }),
  });
}

export function useRemoveHistory() {
  const qc = useQueryClient();
  const { profileId } = useActiveProfile();
  return useMutation({
    mutationFn: (videoId: string) => unwrap(api.DELETE("/video/history/{video_id}", { params: { path: { video_id: videoId }, query: { profile_id: profileId! } } })),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["video", "history"] });
      void qc.invalidateQueries({ queryKey: ["video", "continue"] });
    },
  });
}

/** A playback source for a video (a new stream token; `quality` caps the height). */
export function createVideoSource(videoId: string, profileId: string | undefined, quality?: number) {
  return unwrap(api.POST("/playback/sources", { body: { kind: "video", video_id: videoId, ...pid(profileId), ...(quality && { quality }) } }));
}

/** POST /video/progress (keepalive: also survives the page going away). */
export function reportVideoProgress(profileId: string, videoId: string, position: number, duration: number | null) {
  return unwrap(
    api.POST("/video/progress", {
      body: {
        profile_id: profileId,
        video_id: videoId,
        position_seconds: Math.floor(position),
        ...(duration && Number.isFinite(duration) && { duration_seconds: Math.round(duration) }),
      },
      keepalive: true,
    }),
  );
}

// ---------------------------------------------------------------- admin

export function useAdminVideoStatus() {
  return useQuery({
    queryKey: ["admin", "video", "status"],
    queryFn: () => unwrap(api.GET("/admin/video/status")),
    refetchInterval: 30_000,
  });
}

export function useCheckVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.GET("/admin/video/status", { params: { query: { check: true } } })),
    onSuccess: (s) => qc.setQueryData(["admin", "video", "status"], s),
  });
}

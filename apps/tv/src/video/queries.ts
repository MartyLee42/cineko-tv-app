// «Видео» API on the TV: the tab's rows (continue, subscriptions feed,
// trending, watch later, history), search + suggestions, a video's detail
// (related, qualities), a channel, the playback source and progress reports.
// Every /video endpoint answers 503 video_unavailable while Invidious is down.
import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ApiError, unwrap, type PlaybackSource, type Schemas } from "@martytv/contracts";
import { api } from "../api";
import { queryClient } from "../catalog/queries";
import { activeProfile, useActiveProfileId } from "../profile/active";
import { channelNext, FEED_PAGE, feedNextOffset, retryDelay, searchNextPage, type VideoDetail, type VideoItem } from "./logic";

/** The YouTube service is down / not configured. */
export function isVideoUnavailable(err: unknown): boolean {
  return err instanceof ApiError && (err.code === "video_unavailable" || err.status === 503);
}

// Don't hammer a service that is down; 4xx never get better by retrying.
const retry = (count: number, err: unknown) => !isVideoUnavailable(err) && !(err instanceof ApiError && err.status < 500) && count < 2;
const withProfile = (p: string | null) => (p ? { profile_id: p } : {});

export const videoKey = ["video"] as const;

type VideoChannel = Schemas["VideoChannel"];

type ListPath = "/video/continue" | "/video/watch-later" | "/video/history";

function useList(name: string, path: ListPath) {
  const profile = useActiveProfileId();
  return useQuery({
    queryKey: ["video", name, profile],
    queryFn: () => unwrap(api.GET(path, { params: { query: { profile_id: profile! } } })).then((r) => r.items),
    enabled: !!profile,
    staleTime: 30_000,
    retry,
  });
}

export const useVideoContinue = () => useList("continue", "/video/continue");
export const useVideoWatchLater = () => useList("watch-later", "/video/watch-later");
export const useVideoHistory = () => useList("history", "/video/history");

/** «Подписки»: the subscribed channels' latest uploads, newest first, FEED_PAGE at a time. */
export function useVideoFeed() {
  const profile = useActiveProfileId();
  return useInfiniteQuery({
    queryKey: ["video", "feed", profile],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => unwrap(api.GET("/video/feed", { params: { query: { profile_id: profile!, offset: pageParam, limit: FEED_PAGE } } })),
    getNextPageParam: feedNextOffset,
    enabled: !!profile,
    staleTime: 60_000,
    retry,
  });
}

export function useVideoTrending() {
  const profile = useActiveProfileId();
  return useQuery({
    queryKey: ["video", "trending", profile],
    queryFn: () => unwrap(api.GET("/video/trending", { params: { query: { region: "RU", ...withProfile(profile) } } })).then((r) => r.items),
    staleTime: 5 * 60_000,
    retry,
  });
}

export function useVideoSuggestions(q: string) {
  return useQuery({
    queryKey: ["video", "suggestions", q],
    queryFn: () => unwrap(api.GET("/video/search/suggestions", { params: { query: { q } } })).then((r) => r.items.slice(0, 8)),
    enabled: q.length > 0,
    staleTime: 60 * 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** Search results (videos only on the TV), page by page. */
export function useVideoSearch(q: string) {
  const profile = useActiveProfileId();
  return useInfiniteQuery({
    queryKey: ["video", "search", profile, q],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => unwrap(api.GET("/video/search", { params: { query: { q, type: "video", page: pageParam, ...withProfile(profile) } } })),
    getNextPageParam: (last) => searchNextPage(last),
    enabled: q.length > 0,
    staleTime: 5 * 60_000,
    retry,
  });
}

export const detailKey = (id: string, profile: string | null) => ["video", "video", id, profile] as const;

export function fetchVideoDetail(id: string, profile: string | null): Promise<VideoDetail> {
  return unwrap(api.GET("/video/videos/{video_id}", { params: { path: { video_id: id }, query: withProfile(profile) } }));
}

export function useVideoDetail(id: string) {
  const profile = useActiveProfileId();
  return useQuery({ queryKey: detailKey(id, profile), queryFn: () => fetchVideoDetail(id, profile), staleTime: 5 * 60_000, retry });
}

/** A channel page: its header and uploads, then more uploads page by page (continuation). */
export function useVideoChannel(id: string) {
  const profile = useActiveProfileId();
  return useInfiniteQuery({
    queryKey: ["video", "channel", id, profile],
    initialPageParam: "",
    queryFn: async ({ pageParam }) => {
      if (!pageParam) {
        const ch = await unwrap(api.GET("/video/channels/{channel_id}", { params: { path: { channel_id: id }, query: withProfile(profile) } }));
        return { channel: ch as VideoChannel | null, items: ch.videos, continuation: ch.continuation ?? null };
      }
      const p = await unwrap(
        api.GET("/video/channels/{channel_id}/videos", { params: { path: { channel_id: id }, query: { continuation: pageParam, ...withProfile(profile) } } }),
      );
      return { channel: null as VideoChannel | null, items: p.items, continuation: p.continuation ?? null };
    },
    getNextPageParam: channelNext,
    staleTime: 5 * 60_000,
    retry,
  });
}

/**
 * Retries failed loads by themselves with a growing pause (5 s … 60 s), so a
 * short YouTube/VPN outage heals without a key press. `failed` is the
 * current error state; `retry` runs one attempt. The attempt counter resets
 * once it loads again.
 */
export function useAutoRetry(failed: boolean, retry: () => void) {
  /** Attempts since it last loaded (read and written only in effects / timers). */
  const attempt = useRef(0);
  /** Bumped after each attempt, so a still-failing load schedules the next one. */
  const [tick, setTick] = useState(0);
  const run = useRef(retry);
  useEffect(() => {
    run.current = retry;
  });
  useEffect(() => {
    if (!failed) {
      attempt.current = 0;
      return;
    }
    const t = setTimeout(() => {
      attempt.current += 1;
      setTick((n) => n + 1);
      run.current();
    }, retryDelay(attempt.current));
    return () => clearTimeout(t);
  }, [failed, tick]);
}

/** A fresh playback source (new stream token); `quality` caps the height. */
export function createVideoSource(videoId: string, quality: number | null): Promise<PlaybackSource> {
  const profile = activeProfile.get();
  return unwrap(
    api.POST("/playback/sources", { body: { kind: "video", video_id: videoId, ...withProfile(profile), ...(quality ? { quality } : {}) } }),
  );
}

/** POST /video/progress (fire and forget). */
export function reportVideoProgress(videoId: string, position: number, duration: number | null): Promise<void> {
  const profile = activeProfile.get();
  if (!profile) return Promise.resolve();
  const body: { profile_id: string; video_id: string; position_seconds: number; duration_seconds?: number } = {
    profile_id: profile,
    video_id: videoId,
    position_seconds: Math.floor(position),
  };
  if (duration && isFinite(duration) && duration > 0) body.duration_seconds = Math.round(duration);
  return unwrap(api.POST("/video/progress", { body })).then(
    () => undefined,
    () => undefined,
  );
}

/** After playback: lists with progress (continue, history, cards' bars) are stale. */
export function invalidateVideoLists() {
  for (const k of ["continue", "history", "feed", "trending", "watch-later", "search", "channel"]) void queryClient.invalidateQueries({ queryKey: ["video", k] });
}

/** «Смотреть позже» add / remove; the row and the cached detail update. */
export async function setWatchLater(videoId: string, on: boolean): Promise<void> {
  const profile = activeProfile.get();
  if (!profile) return;
  const params = { path: { video_id: videoId }, query: { profile_id: profile } };
  queryClient.setQueryData<VideoDetail>(detailKey(videoId, profile), (old) => (old ? { ...old, in_watch_later: on } : old));
  try {
    if (on) await unwrap(api.PUT("/video/watch-later/{video_id}", { params }));
    else await unwrap(api.DELETE("/video/watch-later/{video_id}", { params }));
  } finally {
    void queryClient.invalidateQueries({ queryKey: ["video", "watch-later"] });
  }
}

/** Subscribe / unsubscribe a channel (the feed refreshes on the server). */
export async function setSubscribed(channelId: string, on: boolean): Promise<void> {
  const profile = activeProfile.get();
  if (!profile) return;
  const params = { path: { channel_id: channelId }, query: { profile_id: profile } };
  try {
    if (on) await unwrap(api.PUT("/video/subscriptions/{channel_id}", { params }));
    else await unwrap(api.DELETE("/video/subscriptions/{channel_id}", { params }));
  } finally {
    void queryClient.invalidateQueries({ queryKey: ["video", "channel", channelId] });
    void queryClient.invalidateQueries({ queryKey: ["video", "video"] });
    void queryClient.invalidateQueries({ queryKey: ["video", "feed"] });
  }
}

/** A list's items as plain cards (for the player's Up/Down panel). */
export type VideoList = readonly VideoItem[];

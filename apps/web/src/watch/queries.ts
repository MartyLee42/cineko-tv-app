// Phase 5 data: settings, progress, lists, ratings, history, messages.
import { useEffect, useSyncExternalStore } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  unwrap,
  type MediaPage,
  type MediaProgress,
  type MediaUserState,
  type ProfileSettings,
} from "@martytv/contracts";
import { effectiveDesign, useEffectiveDesign } from "@martytv/ui";
import { patchMediaMe } from "@martytv/media-types";
import { api } from "../api";
import { useCatalogLang } from "../catalog/queries";
import { useActiveProfile } from "./ActiveProfile";
import { affectsCatalog, affectsForYou, mergeSettings, setLook, type Settings, type SettingsPatch } from "./settings";
import { deviceClass, useDeviceClass } from "../devsettings/deviceClass";
import type { DeviceClass } from "@martytv/ui";
import { applyWatchedLocally } from "./format";

export type ListName = "watchlist" | "favorites";

/** Per profile and settings class (the look differs on a phone and a computer). */
export const settingsKey = (profileId: string | undefined, cls: DeviceClass = deviceClass.get()) => ["profile-settings", profileId, cls] as const;
export const progressKey = (mediaId: string, profileId: string | undefined) => ["progress", mediaId, profileId] as const;

// ---------------------------------------------------------------- settings

export function useProfileSettings() {
  const { profileId } = useActiveProfile();
  const cls = useDeviceClass();
  return useQuery({
    queryKey: settingsKey(profileId, cls),
    queryFn: async () => mergeSettings(await unwrap(api.GET("/profiles/{id}/settings", { params: { path: { id: profileId! }, query: { device_class: cls } } }))),
    enabled: !!profileId,
    staleTime: 60_000,
  });
}

/** The design shown for these settings now: the chosen one or today's «Сюрприз». */
export function shownDesign(s: Settings, profileId: string | undefined) {
  return effectiveDesign({ design: s.design ?? "kinozal", design_surprise: s.design_surprise, design_favorites: s.design_favorites }, profileId);
}

/** Applies the active profile's design + theme once its settings load (and on switch, and when the «Сюрприз» rolls over). */
export function useThemeSync() {
  const data = useProfileSettings().data;
  const { profileId } = useActiveProfile();
  const theme = data?.theme;
  const design = useEffectiveDesign(data?.design ? { design: data.design, design_surprise: data.design_surprise, design_favorites: data.design_favorites } : null, profileId);
  useEffect(() => {
    if (theme && design) setLook({ theme, design });
  }, [theme, design]);
}

/** Effective settings (defaults while loading / without a profile). */
export function useSettings(): Settings {
  return useProfileSettings().data ?? mergeSettings(undefined);
}

/** Partial PUT with an optimistic cache update; rolls back on failure. */
export function useUpdateSettings() {
  const qc = useQueryClient();
  const { profileId } = useActiveProfile();
  const cls = useDeviceClass();
  const key = settingsKey(profileId, cls);
  return useMutation({
    mutationFn: (patch: SettingsPatch) =>
      // Partial updates are allowed (omitted fields keep their value); the
      // look / playback keys go to this class's layer.
      unwrap(api.PUT("/profiles/{id}/settings", { params: { path: { id: profileId! }, query: { device_class: cls } }, body: patch as ProfileSettings })),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Settings>(key);
      qc.setQueryData<Settings>(key, mergeSettings(prev, patch));
      if (patch.theme || patch.design || patch.design_surprise || patch.design_favorites) {
        const next = mergeSettings(prev, patch);
        setLook({ theme: next.theme ?? "system", design: shownDesign(next, profileId) });
      }
      return { prev };
    },
    onError: (_e, _patch, ctx) => {
      if (ctx?.prev) {
        qc.setQueryData(key, ctx.prev);
        setLook({ theme: ctx.prev.theme, design: shownDesign(ctx.prev, profileId) });
      }
    },
    onSuccess: (saved, patch) => {
      qc.setQueryData<Settings>(key, (cur) => mergeSettings(cur, saved));
      if (affectsCatalog(patch)) invalidateCatalog(qc);
      // The server rebuilds rows in the background (foryou.updated follows);
      // Explore tile counts are per min_votes, so refetch now.
      if (affectsForYou(patch)) void qc.invalidateQueries({ queryKey: ["foryou"] });
      if (patch.show_family !== undefined) void qc.invalidateQueries({ queryKey: ["family"] });
    },
  });
}

export function invalidateCatalog(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ["catalog"] });
  void qc.invalidateQueries({ queryKey: ["media"] });
  void qc.invalidateQueries({ queryKey: ["lists"] });
  void qc.invalidateQueries({ queryKey: ["continue"] });
}

// ---------------------------------------------------------------- hide-watched quick toggle

let hideOverride: boolean | null = null;
const hideListeners = new Set<() => void>();

/** Session-only override of the hide_watched setting (Browse/Search toggle). */
export function setHideWatchedOverride(v: boolean | null) {
  hideOverride = v;
  hideListeners.forEach((l) => l());
}

export function useHideWatchedOverride(): boolean | null {
  return useSyncExternalStore(
    (cb) => {
      hideListeners.add(cb);
      return () => hideListeners.delete(cb);
    },
    () => hideOverride,
    () => null,
  );
}

/** The value in effect: the session toggle, else the profile's setting. */
export function useHideWatched(): boolean {
  const override = useHideWatchedOverride();
  const settings = useSettings();
  return override ?? settings.hide_watched;
}

// ---------------------------------------------------------------- progress

export function useMediaProgress(mediaId: string) {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return useQuery({
    queryKey: [...progressKey(mediaId, profileId), lang],
    queryFn: () =>
      unwrap(api.GET("/media/{id}/progress", { params: { path: { id: mediaId }, query: { profile_id: profileId!, lang } } })),
    enabled: !!profileId,
    staleTime: 15_000,
  });
}

export interface WatchedChange {
  watched: boolean;
  episode_id?: string;
  season_number?: number;
  /** Episodes of the affected season, for the optimistic update. */
  episodes?: { id: string; season_number: number; episode_number: number }[];
}

export function useSetWatched(mediaId: string) {
  const qc = useQueryClient();
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  const key = [...progressKey(mediaId, profileId), lang];
  return useMutation({
    mutationFn: ({ watched, episode_id, season_number }: WatchedChange) =>
      unwrap(
        api.PUT("/media/{id}/watched", {
          params: { path: { id: mediaId }, query: { lang } },
          body: {
            profile_id: profileId!,
            watched,
            ...(episode_id && { episode_id }),
            ...(season_number != null && { season_number }),
          },
        }),
      ),
    onMutate: async (change) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<MediaProgress>(key);
      if (prev) qc.setQueryData(key, applyWatchedLocally(prev, change, change.episodes));
      return { prev };
    },
    onError: (_e, _c, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (progress) => {
      qc.setQueryData(key, progress);
      void qc.invalidateQueries({ queryKey: ["continue"] });
      void qc.invalidateQueries({ queryKey: ["history"] });
      void qc.invalidateQueries({ queryKey: ["catalog"] });
      void qc.invalidateQueries({ queryKey: ["media", mediaId] });
      void qc.invalidateQueries({ queryKey: ["foryou", "curated"] });
    },
  });
}

export function useContinueWatching() {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return useQuery({
    queryKey: ["continue", profileId, lang],
    queryFn: async () =>
      (await unwrap(api.GET("/profiles/{id}/continue-watching", { params: { path: { id: profileId! }, query: { lang } } }))).items,
    enabled: !!profileId,
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}

export function useHistory(limit = 30, enabled = true) {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return useInfiniteQuery({
    queryKey: ["history", profileId, lang, limit],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/profiles/{id}/history", {
          params: { path: { id: profileId! }, query: { lang, limit, ...(pageParam && { cursor: pageParam }) } },
        }),
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !!profileId && enabled,
  });
}

// ---------------------------------------------------------------- lists & ratings

export function useProfileList(list: ListName) {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return useInfiniteQuery({
    queryKey: ["lists", profileId, list, lang],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/profiles/{id}/lists/{list}", {
          params: { path: { id: profileId!, list }, query: { lang, page: pageParam } },
        }),
      ),
    initialPageParam: 1,
    getNextPageParam: (last: MediaPage) => (last.page < last.total_pages ? last.page + 1 : undefined),
    enabled: !!profileId,
  });
}

/** Patches `me` on every cached copy of a title (detail, rows, grids, lists). */
export function patchMe(qc: QueryClient, mediaId: string, patch: Partial<MediaUserState>) {
  for (const prefix of [["media", mediaId], ["catalog"], ["lists"], ["continue"], ["history"], ["foryou"], ["person"], ["family"]]) {
    for (const [key, d] of qc.getQueriesData({ queryKey: prefix })) {
      if (d === undefined) continue;
      const next = patchMediaMe(d, mediaId, patch);
      if (next !== d) qc.setQueryData(key, next);
    }
  }
}

export function useToggleList() {
  const qc = useQueryClient();
  const { profileId } = useActiveProfile();
  return useMutation({
    mutationFn: ({ list, mediaId, on }: { list: ListName; mediaId: string; on: boolean }) => {
      const opts = { params: { path: { id: profileId!, list, mediaId } } };
      return unwrap(on ? api.PUT("/profiles/{id}/lists/{list}/{mediaId}", opts) : api.DELETE("/profiles/{id}/lists/{list}/{mediaId}", opts));
    },
    onMutate: ({ list, mediaId, on }) => patchMe(qc, mediaId, list === "watchlist" ? { in_watchlist: on } : { favorite: on }),
    onError: (_e, { list, mediaId, on }) => patchMe(qc, mediaId, list === "watchlist" ? { in_watchlist: !on } : { favorite: !on }),
    onSettled: (_d, _e, { list }) => qc.invalidateQueries({ queryKey: ["lists", profileId, list] }),
  });
}

export function useRate() {
  const qc = useQueryClient();
  const { profileId } = useActiveProfile();
  return useMutation({
    mutationFn: ({ mediaId, rating }: { mediaId: string; rating: number | null; prev?: number | null }) => {
      const path = { id: profileId!, mediaId };
      return unwrap(
        rating == null
          ? api.DELETE("/profiles/{id}/ratings/{mediaId}", { params: { path } })
          : api.PUT("/profiles/{id}/ratings/{mediaId}", { params: { path }, body: { rating } }),
      );
    },
    onMutate: ({ mediaId, rating }) => patchMe(qc, mediaId, { rating }),
    onError: (_e, { mediaId, prev }) => patchMe(qc, mediaId, { rating: prev ?? null }),
    // A rating counts as watched in «Подборки».
    onSettled: () => qc.invalidateQueries({ queryKey: ["foryou", "curated"] }),
  });
}

// ---------------------------------------------------------------- messages

export function useInbox(enabled = true) {
  return useQuery({
    queryKey: ["messages"],
    queryFn: () => unwrap(api.GET("/messages")),
    enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(api.POST("/messages/{id}/read", { params: { path: { id } } })),
    onMutate: (id) =>
      qc.setQueryData<{ items: { id: string; read_at: string | null }[]; unread: number }>(["messages"], (d) =>
        d
          ? {
              ...d,
              items: d.items.map((m) => (m.id === id && !m.read_at ? { ...m, read_at: new Date().toISOString() } : m)),
              unread: Math.max(0, d.unread - (d.items.some((m) => m.id === id && !m.read_at) ? 1 : 0)),
            }
          : d,
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: ["messages"] }),
  });
}

// Live TV data: channels (one list per profile, filtered client-side), guide,
// per-channel schedule, preferences, playback and the admin playlists.
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { unwrap, type IptvChannel, type Schemas } from "@martytv/contracts";
import { api } from "../api";
import { useActiveProfile } from "../watch/ActiveProfile";

export type ChannelList = Schemas["IptvChannelList"];
export type IptvState = Schemas["IptvState"];
export type AdminPlaylist = Schemas["AdminIptvPlaylist"];
export type PlaylistInput = Schemas["AdminIptvPlaylistInput"];
export type GuidePage = Schemas["IptvGuide"];

export const iptvKey = ["iptv"] as const;
const channelsKey = (profileId: string | undefined, hidden: boolean) => ["iptv", "channels", profileId ?? "", hidden] as const;

/** Every channel of the profile (now/next refreshed each minute). */
export function useChannels(includeHidden = false) {
  const { profileId } = useActiveProfile();
  return useQuery({
    queryKey: channelsKey(profileId, includeHidden),
    queryFn: () =>
      unwrap(
        api.GET("/iptv/channels", {
          params: { query: { ...(profileId && { profile_id: profileId }), ...(includeHidden && { include_hidden: true }) } },
        }),
      ),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useIptvState() {
  const { profileId } = useActiveProfile();
  return useQuery({
    queryKey: ["iptv", "state", profileId ?? ""],
    queryFn: () => unwrap(api.GET("/iptv/state", { params: { query: { ...(profileId && { profile_id: profileId }) } } })),
    staleTime: 60_000,
  });
}

export function useChannelEpg(channelId: string | null) {
  return useQuery({
    queryKey: ["iptv", "epg", channelId],
    queryFn: () => unwrap(api.GET("/iptv/channels/{id}/epg", { params: { path: { id: channelId! } } })).then((r) => r.items),
    enabled: !!channelId,
    staleTime: 5 * 60_000,
  });
}

export const GUIDE_PAGE = 30;

export function useGuide(from: number, to: number, group: string) {
  const { profileId } = useActiveProfile();
  return useInfiniteQuery({
    queryKey: ["iptv", "guide", profileId ?? "", from, to, group],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/iptv/guide", {
          params: {
            query: {
              ...(profileId && { profile_id: profileId }),
              from: new Date(from).toISOString(),
              to: new Date(to).toISOString(),
              ...(group !== "all" && { group }),
              offset: pageParam,
              limit: GUIDE_PAGE,
            },
          },
        }),
      ),
    getNextPageParam: (last) => (last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

type Prefs = { favorite?: boolean; hidden?: boolean; number?: number | null };

/** Replaces one channel in every cached channel list. */
function patchChannel(qc: QueryClient, id: string, patch: Partial<IptvChannel>) {
  qc.setQueriesData<ChannelList>({ queryKey: ["iptv", "channels"] }, (old) =>
    old ? { ...old, items: old.items.map((c) => (c.id === id ? { ...c, ...patch } : c)) } : old,
  );
}

/** Favorite / hidden / number for the active profile (optimistic). */
export function useChannelPrefs() {
  const qc = useQueryClient();
  const { profileId } = useActiveProfile();
  return useMutation({
    mutationFn: ({ id, prefs }: { id: string; prefs: Prefs }) =>
      unwrap(api.PATCH("/iptv/channels/{id}/prefs", { params: { path: { id } }, body: { profile_id: profileId!, ...prefs } })),
    onMutate: async ({ id, prefs }) => {
      await qc.cancelQueries({ queryKey: ["iptv", "channels"] });
      const snapshot = qc.getQueriesData<ChannelList>({ queryKey: ["iptv", "channels"] });
      const patch: Partial<IptvChannel> = {};
      if (prefs.favorite !== undefined) patch.favorite = prefs.favorite;
      if (prefs.hidden !== undefined) patch.hidden = prefs.hidden;
      patchChannel(qc, id, patch);
      return { snapshot };
    },
    onError: (_e, _v, ctx) => ctx?.snapshot.forEach(([k, v]) => qc.setQueryData(k, v)),
    onSuccess: (ch) => patchChannel(qc, ch.id, ch),
    onSettled: (_d, _e, v) => {
      // Hiding changes the visible list and numbering; favorites only the chip count.
      if (v.prefs.hidden !== undefined || v.prefs.number !== undefined) void qc.invalidateQueries({ queryKey: iptvKey });
    },
  });
}

/** A fresh live source (new stream token) for a channel. */
export function createLiveSource(channelId: string, profileId: string | undefined) {
  return unwrap(
    api.POST("/playback/sources", { body: { kind: "iptv", channel_id: channelId, ...(profileId && { profile_id: profileId }) } }),
  );
}

export function reportWatched(channelId: string, profileId: string) {
  return unwrap(api.POST("/iptv/watched", { body: { profile_id: profileId, channel_id: channelId } }));
}

// ---------------------------------------------------------------- admin

const adminKey = ["admin", "iptv"] as const;

export function useAdminPlaylists() {
  return useQuery({
    queryKey: [...adminKey, "playlists"],
    queryFn: () => unwrap(api.GET("/admin/iptv/playlists")),
    // Poll while a playlist or its guide is refreshing.
    refetchInterval: (q) =>
      q.state.data?.items.some((p) => p.refresh.status === "running" || p.epg.status === "running") ? 2000 : false,
  });
}

export function useIptvCountries(enabled: boolean) {
  return useQuery({
    queryKey: [...adminKey, "countries"],
    queryFn: () => unwrap(api.GET("/admin/iptv/countries")).then((r) => r.items),
    enabled,
    staleTime: Infinity,
  });
}

export function useAdminIptv() {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: adminKey });
    void qc.invalidateQueries({ queryKey: iptvKey });
  };
  const create = useMutation({
    mutationFn: (body: PlaylistInput) => unwrap(api.POST("/admin/iptv/playlists", { body })),
    onSettled: done,
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: PlaylistInput }) =>
      unwrap(api.PATCH("/admin/iptv/playlists/{id}", { params: { path: { id } }, body })),
    onSettled: done,
  });
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/admin/iptv/playlists/{id}", { params: { path: { id } } })),
    onSettled: done,
  });
  const refresh = useMutation({
    mutationFn: (id: string) => unwrap(api.POST("/admin/iptv/playlists/{id}/refresh", { params: { path: { id } } })),
    onSettled: done,
  });
  const upload = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      unwrap(
        api.PUT("/admin/iptv/playlists/{id}/content", {
          params: { path: { id } },
          body: text,
          bodySerializer: (b: string) => b,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
      ),
    onSettled: done,
  });
  return { create, update, remove, refresh, upload };
}

// Live TV API: the channel list (with now/next), state for Home, favorites,
// the live playback source and the "watched channel" event.
import { useQuery } from "@tanstack/react-query";
import { unwrap, type IptvChannel, type PlaybackSource, type Schemas } from "@martytv/contracts";
import { api } from "../api";
import { queryClient } from "../catalog/queries";
import { activeProfile, useActiveProfileId } from "../profile/active";

export type IptvChannelList = Schemas["IptvChannelList"];
export type IptvState = Schemas["IptvState"];

export const channelsKey = (profile: string | null) => ["iptv", "channels", profile] as const;
export const stateKey = (profile: string | null) => ["iptv", "state", profile] as const;

/** Every visible channel of the profile (groups are filtered client-side). */
export function fetchChannels(profile: string | null): Promise<IptvChannelList> {
  return unwrap(api.GET("/iptv/channels", { params: { query: profile ? { profile_id: profile } : {} } }));
}

/** Channels with now/next: refreshed every minute (the programme moves on). */
export function useIptvChannels() {
  const profile = useActiveProfileId();
  return useQuery({
    queryKey: channelsKey(profile),
    queryFn: () => fetchChannels(profile),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

/** Last watched channel (Home card); a missing IPTV API reads as "nothing". */
export function useIptvState() {
  const profile = useActiveProfileId();
  return useQuery({
    queryKey: stateKey(profile),
    queryFn: () =>
      unwrap(api.GET("/iptv/state", { params: { query: profile ? { profile_id: profile } : {} } })).catch(() => null as IptvState | null),
    enabled: !!profile,
    staleTime: 60_000,
  });
}

/** ★: per-profile favorite; the list updates optimistically. */
export async function setFavorite(channel: IptvChannel, favorite: boolean): Promise<void> {
  const profile = activeProfile.get();
  if (!profile) return;
  const key = channelsKey(profile);
  queryClient.setQueryData<IptvChannelList>(key, (old) =>
    old ? { ...old, items: old.items.map((c) => (c.id === channel.id ? { ...c, favorite } : c)) } : old,
  );
  try {
    await unwrap(api.PATCH("/iptv/channels/{id}/prefs", { params: { path: { id: channel.id } }, body: { profile_id: profile, favorite } }));
  } finally {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

/** A live source for the channel (fresh signed stream URL). */
export function createLiveSource(channelId: string): Promise<PlaybackSource> {
  const profile = activeProfile.get();
  const body: { kind: "iptv"; channel_id: string; profile_id?: string } = { kind: "iptv", channel_id: channelId };
  if (profile) body.profile_id = profile;
  return unwrap(api.POST("/playback/sources", { body }));
}

/** "Watched channel" (live TV has no progress): remembers the last channel. */
export function reportWatched(channelId: string): void {
  const profile = activeProfile.get();
  if (!profile) return;
  void unwrap(api.POST("/iptv/watched", { body: { profile_id: profile, channel_id: channelId } }))
    .then(() => queryClient.invalidateQueries({ queryKey: stateKey(profile) }))
    .catch(() => undefined);
}

/** One channel's details (from the cached list, else fetched). */
export async function findChannel(id: string): Promise<{ channel: IptvChannel; list: IptvChannel[] } | null> {
  const profile = activeProfile.get();
  const cached = queryClient.getQueryData<IptvChannelList>(channelsKey(profile));
  const data = cached && cached.items.some((c) => c.id === id) ? cached : await queryClient.fetchQuery({ queryKey: channelsKey(profile), queryFn: () => fetchChannels(profile), staleTime: 60_000 });
  const channel = data.items.find((c) => c.id === id);
  return channel ? { channel, list: data.items } : null;
}

/** One channel's programmes for the local day (00:00–24:00) — «Программа на сегодня». */
export function useChannelDay(channelId: string, from: Date, to: Date, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["iptv", "day", channelId, from.toISOString()],
    queryFn: () =>
      unwrap(api.GET("/iptv/channels/{id}/epg", { params: { path: { id: channelId }, query: { from: from.toISOString(), to: to.toISOString() } } })).then((r) => r.items),
    staleTime: 10 * 60_000,
  });
}

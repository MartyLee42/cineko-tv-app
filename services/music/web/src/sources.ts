// Where a track's sound comes from, and the "choose a source" dialog's tabs.
// Any track known by artist + title can be looked up on every provider —
// catalog ("dz:"), imported / AI ("yq:"), a YouTube or zaycev upload, a
// torrent file — so the track menu offers the same thing in every list.
// Pure logic, unit-tested in Node.

import type { Candidate, Track, TorrentSrc, ZvCandidate } from "./api";

export type Provider = "zaycev" | "youtube" | "torrents";
export type SourceTab = "all" | Provider;

export const PROVIDERS: readonly Provider[] = ["zaycev", "youtube", "torrents"];

export const PROVIDER_LABEL: Record<SourceTab, string> = {
  all: "Все",
  zaycev: "Zaycev",
  youtube: "YouTube",
  torrents: "Торренты",
};

export interface Features {
  youtube: boolean;
  torrents: boolean;
}

/** Providers to search for a track (zaycev needs no setup on the server). */
export function providersFor(t: Pick<Track, "title">, f: Features | undefined): Provider[] {
  if (!t.title.trim()) return [];
  return PROVIDERS.filter((p) => p === "zaycev" || (p === "youtube" ? (f?.youtube ?? true) : (f?.torrents ?? false)));
}

/** The chosen recording is remembered (household-wide) for catalog and imported tracks; others just play it. */
export function canSave(t: Pick<Track, "id">): boolean {
  return /^dz:\d+$/.test(t.id) || /^yq:[0-9a-f]{20}$/.test(t.id);
}

/** Query naming a track for /sources/{provider}. */
export function sourceQuery(t: Pick<Track, "id" | "artist" | "title" | "duration" | "album">): string {
  const q = new URLSearchParams({ id: t.id, artist: t.artist, title: t.title, duration: String(t.duration || 0) });
  if (t.album) q.set("album", t.album);
  return q.toString();
}

/** One row of the dialog, whatever the provider. */
export interface SourceItem {
  provider: "zaycev" | "youtube";
  /** What /sources/match stores (video id or "zv:<n>"); also the "yt:" / "zv:" track to play once. */
  value: string;
  title: string;
  sub: string;
  duration: number;
  current: boolean;
}

export interface SourcesReply<T> {
  current: string;
  saved: boolean;
  torrent?: TorrentSrc;
  items: T[];
}

/** The source the track plays from now (null: not known yet). */
export function currentSource(t: Pick<Track, "id" | "src">, current: string, torrent?: TorrentSrc): { provider: Provider; value: string } | null {
  if (torrent || t.src || t.id.startsWith("t:")) return { provider: "torrents", value: "" };
  if (t.id.startsWith("zv:")) return { provider: "zaycev", value: t.id };
  if (t.id.startsWith("yt:")) return { provider: "youtube", value: t.id.slice(3) };
  if (current.startsWith("zv:")) return { provider: "zaycev", value: current };
  if (current) return { provider: "youtube", value: current };
  return null;
}

export function youtubeItems(list: Candidate[], cur: string | null): SourceItem[] {
  return list.map((c) => ({ provider: "youtube", value: c.videoId, title: c.title, sub: c.author, duration: c.duration, current: c.videoId === cur }));
}

export function zaycevItems(list: ZvCandidate[], cur: string | null): SourceItem[] {
  return list.map((c) => ({
    provider: "zaycev",
    value: c.id,
    title: c.title,
    sub: `${c.artist}${c.bitrate ? ` · ${c.bitrate} кбит/с` : ""}`,
    duration: c.duration,
    current: c.id === cur,
  }));
}

/** The track to play for a one-off choice (tracks whose choice isn't saved). */
export function itemTrack(t: Track, it: SourceItem): Track {
  const id = it.provider === "zaycev" ? it.value : `yt:${it.value}`;
  return { ...t, id, src: undefined, duration: it.duration || t.duration };
}

export type TabStatus = "idle" | "loading" | "error" | "ok";

export interface ProviderState {
  status: TabStatus;
  count: number;
}

export interface TabView {
  id: SourceTab;
  label: string;
  /** null while unknown (loading, error, torrents not searched yet). */
  count: number | null;
  loading: boolean;
  error: boolean;
  /** The track plays from this provider now. */
  current: boolean;
}

/** Tab bar: «Все» then one per provider, with counts and the current source marked. */
export function sourceTabs(providers: Provider[], state: Partial<Record<Provider, ProviderState>>, current: Provider | null): TabView[] {
  const per = providers.map((p): TabView => {
    const s = state[p] ?? { status: "idle", count: 0 };
    return {
      id: p,
      label: PROVIDER_LABEL[p],
      count: s.status === "ok" ? s.count : null,
      loading: s.status === "loading",
      error: s.status === "error",
      current: current === p,
    };
  });
  const known = per.filter((t) => t.count !== null);
  const all: TabView = {
    id: "all",
    label: PROVIDER_LABEL.all,
    count: known.length ? known.reduce((n, t) => n + (t.count ?? 0), 0) : null,
    loading: per.some((t) => t.loading),
    error: false,
    current: false,
  };
  return [all, ...per];
}

/** «Все»: the best few of each provider, in provider order, the current one first in its group. */
export function allPreview(groups: Partial<Record<"zaycev" | "youtube", SourceItem[]>>, perGroup = 3): SourceItem[] {
  const out: SourceItem[] = [];
  for (const p of ["zaycev", "youtube"] as const) {
    const list = groups[p] ?? [];
    const cur = list.filter((i) => i.current);
    out.push(...cur, ...list.filter((i) => !i.current).slice(0, Math.max(0, perGroup - cur.length)));
  }
  return out;
}

/** Torrent search terms for a track: its album when known, else artist + title. */
export function torrentQuery(t: Pick<Track, "artist" | "title" | "album">): { artist?: string; album?: string; text?: string } {
  const artist = t.artist.split(",")[0]!.trim();
  return t.album ? { artist, album: t.album } : { text: `${artist} ${t.title}`.trim() };
}

/** The track menu's source entries — the same for every list (search, album, playlist, queue, now playing). */
export function sourceMenu(t: Pick<Track, "id" | "title">, f: Features | undefined): { label: string; tab: SourceTab }[] {
  const ps = providersFor(t, f);
  if (ps.length === 0) return [];
  const items: { label: string; tab: SourceTab }[] = [{ label: "Не та запись? Выбрать источник", tab: "all" }];
  if (ps.includes("torrents")) items.push({ label: "Найти в торрентах (MP3 / FLAC)", tab: "torrents" });
  return items;
}

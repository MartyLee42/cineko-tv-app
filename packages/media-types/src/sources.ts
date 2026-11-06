// Sources (Prowlarr, Jacred, AniLiberty…): the profile's selection, online
// variant grouping and the HLS playback decision, shared by the PWA and the
// TV app. Structural types only (no dependency on the generated contracts).

/** ProfileSettings.sources.enabled: "all" (default) or explicit ids. */
export type SourcesEnabled = "all" | string[];

/** Whether the profile's selection includes `id`. */
export function isSourceOn(enabled: SourcesEnabled | null | undefined, id: string): boolean {
  if (!enabled || enabled === "all") return true;
  return enabled.includes(id);
}

/**
 * The selection after switching one source on/off. `all` lists every known
 * source id (GET /sources); when every one of them is on the result is
 * "all" again, so sources added later are used too.
 */
export function setSourceOn(enabled: SourcesEnabled | null | undefined, all: readonly string[], id: string, on: boolean): SourcesEnabled {
  const current = !enabled || enabled === "all" ? [...all] : enabled.filter((x) => x !== id);
  const next = on ? [...new Set([...current, id])] : current.filter((x) => x !== id);
  if (all.length > 0 && all.every((x) => next.includes(x))) return "all";
  // Keep the known order (stable diffs, readable settings).
  const order = (x: string) => {
    const i = all.indexOf(x);
    return i < 0 ? all.length : i;
  };
  return next.sort((a, b) => order(a) - order(b));
}

// ---------------------------------------------------------------- online variants

export interface ProviderStatusLike {
  id: string;
  name: string;
  kind: string;
  status: "ok" | "empty" | "error" | "timeout";
  error?: string | null;
}

export interface OnlineListLike<V> {
  items: V[];
  providers: ProviderStatusLike[];
}

export interface OnlineGroupView<V> {
  items: V[];
  /** Providers that failed or timed out (a quiet status line). */
  failed: ProviderStatusLike[];
  /** Show the group at all: it has items or a provider failed. */
  show: boolean;
}

/** The «Аниме · AniLiberty» group of the release list for one kind of source. */
export function onlineGroup<V extends { provider: { kind: string } }>(
  list: OnlineListLike<V> | null | undefined,
  kind: "anime" | "online" = "anime",
): OnlineGroupView<V> {
  if (!list) return { items: [], failed: [], show: false };
  const items = list.items.filter((v) => v.provider.kind === kind);
  const failed = list.providers.filter((p) => p.kind === kind && (p.status === "error" || p.status === "timeout"));
  return { items, failed, show: items.length > 0 || failed.length > 0 };
}

/** Provider names of a group, for its title («Аниме · AniLiberty»). */
export function groupProviders(items: readonly { provider: { name: string } }[], failed: readonly ProviderStatusLike[] = []): string[] {
  return [...new Set([...items.map((v) => v.provider.name), ...failed.map((p) => p.name)])];
}

/** "1–12", "1, 3, 5–7": compact episode list of a season-level variant. */
export function episodeRanges(eps: readonly number[]): string {
  const xs = [...new Set(eps)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < xs.length; ) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j]! + 1) j++;
    out.push(j - i >= 2 ? `${xs[i]}–${xs[j]}` : j === i ? `${xs[i]}` : `${xs[i]}, ${xs[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

/** "1080p · 720p · 480p" (best first). */
export function qualitiesLabel(qs: readonly number[]): string {
  return [...new Set(qs)]
    .sort((a, b) => b - a)
    .map((q) => `${q}p`)
    .join(" · ");
}

/** Whether a variant can play `episode` (season-level variants list theirs). */
export function variantHasEpisode(v: { episode?: number | null; episodes?: number[] }, episode: number | null | undefined): boolean {
  if (episode == null) return true;
  if (v.episode != null) return v.episode === episode;
  return !v.episodes || v.episodes.length === 0 || v.episodes.includes(episode);
}

export interface VariantLike {
  id: string;
  provider: { id: string; name: string; kind: "torrent" | "online" | "anime" };
  voice: string;
  voiceover: { kind: "dub" | "mvo" | "dvo" | "avo" | "vo" | "original" | null; studio: string | null; language: string };
  title: string | null;
  max_quality: number | null;
  qualities: number[];
  format: "mp4" | "hls";
  season: number | null;
  episode: number | null;
  episodes: number[];
}

const RESOLUTIONS = ["2160p", "1080p", "720p", "576p", "480p"] as const;

/**
 * An online variant as a Release (the shape the release flows pass around;
 * the server stores the same for the source): `id` is the variant id, the
 * voice shows as the voice-over and the provider as the indexer.
 */
export function variantRelease(v: VariantLike) {
  const res = v.max_quality ? `${v.max_quality}p` : null;
  return {
    id: v.id,
    provider: v.provider,
    title: v.title || v.provider.name,
    indexer: v.provider.name,
    size_bytes: 0,
    seeders: 0,
    leechers: null,
    published_at: null,
    info_hash: null,
    resolution: (RESOLUTIONS as readonly string[]).includes(res ?? "") ? (res as (typeof RESOLUTIONS)[number]) : null,
    video_codec: null,
    hdr: null,
    audio_codecs: [] as string[],
    languages: [v.voiceover.language || "ru"],
    voiceovers: [{ ...v.voiceover, studio: v.voiceover.studio ?? v.voice }],
    release_group: null,
    source_quality: null,
    year: null,
    seasons: v.season != null ? [v.season] : ([] as number[]),
    episodes: v.episode != null ? [v.episode] : ([] as number[]),
    is_season_pack: false,
    confidence: 1,
    score: 1,
    reasons: [] as string[],
    warnings: [] as string[],
  };
}

// ---------------------------------------------------------------- HLS

export type HlsMode = "native" | "hlsjs" | "none";

export interface HlsProbe {
  canPlayType(type: string): string;
}

/**
 * How to play an HLS stream_url: the engine's own HLS when canPlayType says
 * maybe/probably (Safari/iOS, most TV engines), else hls.js where Media
 * Source Extensions exist, else not at all. `preferMse`: hls.js wins over
 * the engine's own HLS whenever MSE exists — Android (Chrome / WebView),
 * whose native HLS runs through the system MediaPlayer: a seek far into a
 * film re-fetched the same segments over and over without ever playing,
 * and the picture went black until the buffer refilled (see isAndroid).
 */
export function hlsMode(probe: HlsProbe | null | undefined, hasMse: boolean, preferMse = false): HlsMode {
  if (preferMse && hasMse) return "hlsjs";
  let native: string;
  try {
    native = probe?.canPlayType("application/vnd.apple.mpegurl") || probe?.canPlayType("application/x-mpegURL") || "";
  } catch {
    native = "";
  }
  if (native === "maybe" || native === "probably") return "native";
  return hasMse ? "hlsjs" : "none";
}

/** Android (phone browser, TV-box WebView, MSX on Android): hls.js plays HLS better than its native player. */
export function isAndroid(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): boolean {
  return /Android/i.test(ua);
}

/** Media Source Extensions (hls.js needs them; iOS 17+ has ManagedMediaSource). */
export function hasMediaSource(w: unknown = typeof window !== "undefined" ? window : undefined): boolean {
  const g = w as { MediaSource?: unknown; ManagedMediaSource?: unknown; WebKitMediaSource?: unknown } | undefined;
  return !!(g && (g.MediaSource || g.ManagedMediaSource || g.WebKitMediaSource));
}

/** Is this source an HLS stream (format, else the MIME type)? */
export function isHlsSource(s: { format?: string | null; mime_type?: string | null }): boolean {
  if (s.format) return s.format === "hls";
  const m = (s.mime_type ?? "").toLowerCase();
  return m.includes("mpegurl");
}

// ---------------------------------------------------------------- skip markers

export interface SkipMarkerLike {
  kind: "opening" | "ending";
  start_seconds: number;
  end_seconds: number;
}

/** The marker the position is in (skip button), ignoring its last 2 s. */
export function activeMarker<M extends SkipMarkerLike>(markers: readonly M[] | null | undefined, position: number, kinds: readonly M["kind"][] = ["opening"]): M | null {
  for (const m of markers ?? []) {
    if (!kinds.includes(m.kind) || m.end_seconds - m.start_seconds < 5) continue;
    if (position >= m.start_seconds && position < m.end_seconds - 2) return m;
  }
  return null;
}

// Shared media model helpers used by the PWA and the TV app.
// API types themselves come from @martytv/contracts (generated from OpenAPI).

/** Internal Cineko media ID (UUID). External IDs (TMDB, IMDb) live separately. */
export type MediaId = string;

export type MediaKind = "movie" | "series";

export interface MediaRef {
  id: MediaId;
  kind: MediaKind;
  title: string;
}

/** Subset of CatalogConfig needed to build image URLs. */
export interface ImageConfig {
  image_base_url: string;
}

export type PosterSize = "w92" | "w154" | "w185" | "w342" | "w500" | "w780" | "original";
export type BackdropSize = "w300" | "w780" | "w1280" | "original";
export type ProfileSize = "w185" | "h632" | "original";
export type StillSize = "w92" | "w185" | "w300" | "original";
export type ImageSize = PosterSize | BackdropSize | ProfileSize | StillSize;

/**
 * Builds an image URL from a TMDB file path. Returns null when the path is
 * missing so callers can render a placeholder.
 */
export function imageUrl(cfg: ImageConfig | undefined, path: string | null | undefined, size: ImageSize): string | null {
  if (!cfg || !path) return null;
  return `${cfg.image_base_url}/${size}${path.startsWith("/") ? path : `/${path}`}`;
}

/** 135 → "2h 15m" (en) / "2 ч 15 мин" (ru). */
export function formatRuntime(minutes: number | null | undefined, locale: string): string | null {
  if (!minutes || minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (locale.startsWith("ru")) return h ? `${h} ч${m ? ` ${m} мин` : ""}` : `${m} мин`;
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

/** 7.25 → "7.3"; null → null. */
export function formatRating(r: number | null | undefined): string | null {
  return r == null ? null : r.toFixed(1);
}

/** S01E05 */
export function episodeCode(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

/** "2024-05-01" → localized date; null-safe. */
export function formatDate(iso: string | null | undefined, locale: string): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** Deterministic placeholder colour for a title without a poster. */
export function placeholderColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 35% 22%)`;
}

/** Content language for catalog requests from a UI locale. */
export function catalogLang(locale: string): "en" | "ru" {
  // Kazakh: the interface is Kazakh, titles and plots come in Russian (TMDB has little Kazakh).
  return locale.startsWith("ru") || locale.startsWith("kk") ? "ru" : "en";
}

export * from "./sources";
export * from "./countries";
export * from "./playbackPrefs";
export * from "./speedtest";
export * from "./speedtestAgent";
export * from "./newEpisodes";
export * from "./fit";
export * from "./fileFormat";
export * from "./videoNext";
export * from "./smooth";
export * from "./chapters";
export * from "./filmTheme";
export * from "./quickRate";
export * from "./livePlay";

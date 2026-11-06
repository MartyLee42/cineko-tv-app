// Server downloads: pure formatting, chip text, sorting and cache helpers (tested).
import type { Release, Schemas } from "@martytv/contracts";
import type { Locale, MessageKey } from "@martytv/ui";
import { formatBytes } from "../admin/format";

export type Download = Schemas["Download"];
export type DownloadBrief = Schemas["DownloadBrief"];
export type DownloadStatus = Schemas["DownloadStatus"];
export type StorageStatus = Schemas["StorageStatus"];
export type TorrServerTorrent = Schemas["TorrServerTorrent"];

type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

const KB = 1024;
const MB = 1024 ** 2;

/** Statuses that still need work (not done / failed). */
export const ACTIVE: readonly DownloadStatus[] = ["queued", "downloading", "paused", "waiting_space"];

export function isActive(s: DownloadStatus): boolean {
  return ACTIVE.includes(s);
}

/** 0…1 → whole percent, never 100 before it is done. */
export function progressPercent(d: Pick<DownloadBrief, "status" | "progress">): number {
  if (d.status === "done") return 100;
  const p = Math.floor((Number.isFinite(d.progress) ? d.progress : 0) * 100);
  return Math.max(0, Math.min(99, p));
}

/** Seconds → "~35 мин" / "~2 ч 10 мин" (en: "~35 min" / "~2 h 10 min"). */
export function formatEta(seconds: number | null | undefined, locale: Locale): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const [h, m] = locale === "ru" ? ["ч", "мин"] : ["h", "min"];
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `~${mins} ${m}`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `~${hours} ${h} ${rest} ${m}` : `~${hours} ${h}`;
}

/** Bytes/s → "1,2 МБ/с" (ru, comma) / "1.2 MB/s"; under 1 MB/s in KB/s. */
export function formatRate(bps: number | null | undefined, locale: Locale): string | null {
  if (bps == null || !Number.isFinite(bps) || bps <= 0) return null;
  const [kb, mb] = locale === "ru" ? ["КБ/с", "МБ/с"] : ["KB/s", "MB/s"];
  if (bps >= MB) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bps / MB)} ${mb}`;
  return `${Math.max(1, Math.round(bps / KB))} ${kb}`;
}

/** "28.11" (ru) / "Nov 28" (en); the year is added when it isn't this year. */
export function formatKeepDate(iso: string | null | undefined, locale: Locale, now: number): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const otherYear = d.getFullYear() !== new Date(now).getFullYear();
  const opts: Intl.DateTimeFormatOptions =
    locale === "ru"
      ? { day: "2-digit", month: "2-digit", ...(otherYear && { year: "numeric" }) }
      : { month: "short", day: "numeric", ...(otherYear && { year: "numeric" }) };
  return new Intl.DateTimeFormat(locale === "ru" ? "ru-RU" : "en-US", opts).format(d);
}

export type ChipTone = "progress" | "wait" | "error" | "done";

/**
 * Status chip: «Загружается 42% · 1,2 МБ/с · ~35 мин», «На сервере ✓ · хранится до 28.11», …
 * `short` (rows that show size / rate / keep-until on their own line): status only.
 */
export function chipInfo(d: DownloadBrief, t: TFn, locale: Locale, now: number, short = false): { tone: ChipTone; text: string } {
  switch (d.status) {
    case "downloading": {
      const parts = [
        t("downloads.status.downloading_short", { percent: progressPercent(d) }),
        short ? null : formatRate(d.rate_bps, locale),
        short ? null : formatEta(d.eta_seconds, locale),
      ];
      return { tone: "progress", text: parts.filter(Boolean).join(" · ") };
    }
    case "queued":
      return { tone: "wait", text: t("downloads.status.queued") };
    case "waiting_space":
      return { tone: "wait", text: t("downloads.status.waiting_space") };
    case "paused": {
      const pct = progressPercent(d);
      return { tone: "wait", text: pct > 0 ? `${t("downloads.status.paused")} · ${pct}%` : t("downloads.status.paused") };
    }
    case "failed":
      return { tone: "error", text: t("downloads.status.failed") };
    case "done": {
      const until = formatKeepDate(d.keep_until, locale, now);
      const extra = short ? null : d.pinned ? t("downloads.pinned") : until ? t("downloads.kept_until", { date: until }) : null;
      return { tone: "done", text: extra ? `${t("downloads.on_server")} · ${extra}` : t("downloads.on_server") };
    }
  }
}

/** Error explanation for failed / waiting_space rows (null when there's nothing to add). */
export function errorKey(d: Pick<Download, "status" | "error">): MessageKey | null {
  if (d.status !== "failed") return null;
  switch (d.error) {
    case "size_mismatch":
      return "downloads.error.size_mismatch";
    case "upstream_error":
      return "downloads.error.upstream_error";
    case "write_error":
      return "downloads.error.write_error";
    default:
      return null;
  }
}

/** POST /downloads error codes → message. */
export function createErrorKey(code: string): MessageKey {
  switch (code) {
    case "not_a_torrent":
      return "downloads.error.not_a_torrent";
    case "library_unavailable":
      return "downloads.error.library_unavailable";
    case "source_not_ready":
      return "downloads.error.source_not_ready";
    default:
      return "downloads.error.failed";
  }
}

/** The release holds a whole season (pack, or seasons without episode numbers). */
export function canDownloadSeason(r: Pick<Release, "is_season_pack" | "seasons" | "episodes">): boolean {
  return r.is_season_pack || ((r.seasons?.length ?? 0) > 0 && (r.episodes?.length ?? 0) === 0);
}

/** Online variants can't be downloaded; torrent releases can. */
export function isTorrentRelease(r: Pick<Release, "provider">): boolean {
  return !r.provider || r.provider.kind === "torrent";
}

/** The downloads that belong to a movie (episodeId omitted) or one episode. */
export function downloadsFor<T extends Pick<Download, "episode_id" | "season" | "episode">>(
  items: readonly T[],
  target: { episode_id?: string | null; season_number?: number | null; episode_number?: number | null },
): T[] {
  if (!target.episode_id) return items.filter((d) => !d.episode_id && d.season == null);
  return items.filter(
    (d) =>
      d.episode_id === target.episode_id ||
      (!d.episode_id && d.season != null && d.season === target.season_number && d.episode === target.episode_number),
  );
}

const CHIP_ORDER: Record<DownloadStatus, number> = { downloading: 0, waiting_space: 1, queued: 2, paused: 3, done: 4, failed: 5 };

/** The one download a chip shows when several exist (running first, then done, failed last). */
export function primaryDownload<T extends Pick<Download, "status">>(items: readonly T[]): T | null {
  return [...items].sort((a, b) => CHIP_ORDER[a.status] - CHIP_ORDER[b.status])[0] ?? null;
}

export type SortKey = "newest" | "size" | "age";

/** Admin table: newest first, largest first, or oldest first (completion, else creation). */
export function sortDownloads<T extends Pick<Download, "size" | "created_at" | "completed_at">>(items: readonly T[], by: SortKey): T[] {
  const time = (d: T) => Date.parse(d.completed_at ?? d.created_at) || 0;
  const out = [...items];
  if (by === "size") out.sort((a, b) => b.size - a.size);
  else if (by === "age") out.sort((a, b) => time(a) - time(b));
  else out.sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0));
  return out;
}

/** TorrServer torrents nothing uses: safe for «Удалить неактивные». */
export function inactiveTorrents<T extends Pick<TorrServerTorrent, "idle" | "martytv">>(items: readonly T[]): T[] {
  return items.filter((x) => x.idle && !x.martytv.in_use);
}

export interface DiskSegments {
  other: number;
  library: number;
  reserve: number;
  free: number;
  total: number;
}

/** Disk bar: other data | library | reserve | free (bytes, summing to total). */
export function diskSegments(s: Pick<StorageStatus, "disk_total_bytes" | "disk_free_bytes" | "library_used_bytes" | "reserve_bytes">): DiskSegments {
  const total = Math.max(0, s.disk_total_bytes);
  const freeAll = Math.min(total, Math.max(0, s.disk_free_bytes));
  const library = Math.min(total - freeAll, Math.max(0, s.library_used_bytes));
  const other = Math.max(0, total - freeAll - library);
  const reserve = Math.min(freeAll, Math.max(0, s.reserve_bytes));
  return { other, library, reserve, free: freeAll - reserve, total };
}

/**
 * Keep days for the rules text (non-admins can't read the setting): from a done,
 * unpinned download's keep_until − max(completed, last watched); else the default.
 */
export function keepDaysFrom(items: readonly Pick<Download, "status" | "pinned" | "keep_until" | "completed_at" | "last_watched_at">[], fallback = 30): number {
  for (const d of items) {
    if (d.status !== "done" || d.pinned || !d.keep_until || !d.completed_at) continue;
    const base = Math.max(Date.parse(d.completed_at), d.last_watched_at ? Date.parse(d.last_watched_at) : 0);
    const days = Math.round((Date.parse(d.keep_until) - base) / 86_400_000);
    if (days >= 1 && days <= 3650) return days;
  }
  return fallback;
}

export interface ListFilter {
  media_id?: string;
  status?: DownloadStatus;
}

export function matchesFilter(d: Pick<Download, "media_id" | "status">, f: ListFilter): boolean {
  return (!f.media_id || d.media_id === f.media_id) && (!f.status || d.status === f.status);
}

/**
 * Applies a `download.updated` payload to a cached list. Realtime payloads carry
 * `media: null`, so the cached media is kept. Returns null when the id isn't in
 * the list but would belong to it (the caller refetches), or the list unchanged.
 */
export function applyUpdate<T extends Download>(list: readonly T[], d: Download, f: ListFilter): T[] | null {
  const i = list.findIndex((x) => x.id === d.id);
  if (i < 0) return matchesFilter(d, f) ? null : (list as T[]);
  const old = list[i]!;
  const merged = { ...old, ...d, media: d.media ?? old.media, users: d.users ?? old.users } as T;
  if (!matchesFilter(merged, f)) return list.filter((x) => x.id !== d.id);
  const out = [...list];
  out[i] = merged;
  return out;
}

/** The PlaybackSource.download brief for a full Download. */
export function briefOf(d: Download): DownloadBrief {
  return {
    id: d.id,
    status: d.status,
    progress: d.progress,
    bytes_done: d.bytes_done,
    size: d.size,
    rate_bps: d.rate_bps,
    eta_seconds: d.eta_seconds,
    completed_at: d.completed_at,
    keep_until: d.keep_until,
    pinned: d.pinned,
    mine: d.mine,
  };
}

/** Size line: «1,2 ГБ из 4,5 ГБ · 1,2 МБ/с · ~35 мин» or «4,5 ГБ · хранится до 28.11». */
export function sizeLine(d: Download, t: TFn, locale: Locale, now: number): string {
  if (d.status === "done") {
    const until = formatKeepDate(d.keep_until, locale, now);
    return [formatBytes(d.size, locale), d.pinned ? t("downloads.pinned") : until ? t("downloads.kept_until", { date: until }) : null]
      .filter(Boolean)
      .join(" · ");
  }
  return [
    t("downloads.of", { done: formatBytes(d.bytes_done, locale), total: formatBytes(d.size, locale) }),
    d.status === "downloading" ? formatRate(d.rate_bps, locale) : null,
    d.status === "downloading" ? formatEta(d.eta_seconds, locale) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

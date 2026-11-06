// «Видео»: pure helpers (formatting, progress, resume, description links).
import { ApiError, type Schemas } from "@martytv/contracts";

export type VideoItem = Schemas["VideoItem"];
export type VideoProgress = Schemas["VideoProgress"];
export type PluralForm = "one" | "few" | "many" | "other";

/** 3:07 / 1:02:03; "" when unknown (live streams). */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** 999 → "999", 12 345 → "12 тыс." / "12K", 1 234 567 → "1,2 млн" / "1.2M". */
export function compactCount(n: number, locale: string): string {
  if (Math.abs(n) < 1000) return new Intl.NumberFormat(locale).format(n);
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: n < 10_000 ? 1 : n < 1_000_000 ? 0 : 1 }).format(n);
}

/**
 * The plural form for a count's noun. Abbreviated counts (≥ 1000) read as
 * «тыс. просмотров» / «1.2M views»: genitive plural in Russian, plural in English.
 */
export function countForm(n: number, locale: string): PluralForm {
  if (Math.abs(n) >= 1000) return locale.startsWith("ru") ? "many" : "other";
  const f = new Intl.PluralRules(locale).select(n);
  return f === "one" || f === "few" || f === "many" ? f : "other";
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["week", 7 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

/** «3 дня назад» / «2 weeks ago» (YouTube dates are approximate anyway); "" without a date. */
export function relativeDate(iso: string | null | undefined, now: number, locale: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Math.round((t - now) / 1000);
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (abs >= size) return rtf.format(Math.trunc(diff / size), unit);
  }
  return rtf.format(0, "minute");
}

/** Watched share 0…100 for a card's progress bar (finished = 100, nothing = 0). */
export function progressPercent(p: VideoProgress | null | undefined, duration?: number | null): number {
  if (!p) return 0;
  if (p.finished) return 100;
  const d = p.duration_seconds || duration || 0;
  if (d <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((p.position_seconds / d) * 100)));
}

/** Where playback starts: the saved position unless it's missing, tiny or at the very end. */
export function resumePosition(position: number | null | undefined, duration: number | null | undefined): number {
  if (!position || position < 5) return 0;
  if (duration && position > duration - Math.min(20, duration * 0.08)) return 0;
  return position;
}

/** The YouTube service is down / not configured (503 video_unavailable). */
export function isVideoUnavailable(err: unknown): boolean {
  return err instanceof ApiError && (err.code === "video_unavailable" || err.status === 503);
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/** 1080 → "1080p". */
export function qualityLabel(height: number): string {
  return `${height}p`;
}

/** Appends a page of videos, dropping ones already shown (continuations overlap). */
export function appendUnique<T extends { id: string }>(items: T[], more: T[]): T[] {
  const seen = new Set(items.map((v) => v.id));
  return [...items, ...more.filter((v) => !seen.has(v.id) && seen.add(v.id))];
}

export type TextPart = { text: string; href?: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"«»]+/g;

/** Splits a plain-text description into text and http(s) links (trailing punctuation stays text). */
export function linkify(text: string): TextPart[] {
  const out: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    const trail = /[.,;:!?)\]]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    const start = m.index;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: url, href: url });
    last = start + url.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Progress reports: every `every` seconds of playback or after a seek of more than that. */
export function shouldReport(lastSent: number | null, position: number, every = 10): boolean {
  if (!Number.isFinite(position) || position < 1) return false;
  return lastSent == null || Math.abs(position - lastSent) >= every;
}

/** The tabs of /video (?tab=…). */
export const TABS = ["subscriptions", "trending", "search", "watch_later", "history"] as const;
export type VideoTab = (typeof TABS)[number];

export function parseTab(v: string | null): VideoTab {
  return (TABS as readonly string[]).includes(v ?? "") ? (v as VideoTab) : "subscriptions";
}

// ---------------------------------------------------------------- paging

/** «Подписки» page size (the feed is paged with offset / next_offset). */
export const FEED_PAGE = 50;

/** The next feed offset, or undefined after the last page. */
export function feedNextOffset(last: { next_offset?: number | null } | undefined): number | undefined {
  const n = last?.next_offset;
  return typeof n === "number" && n > 0 ? n : undefined;
}

/** The next search page: while pages bring videos, up to `max`. */
export function searchNextPage(last: { page: number; videos: unknown[] } | undefined, max: number): number | undefined {
  return last && last.videos.length > 0 && last.page < max ? last.page + 1 : undefined;
}

/** A channel's next continuation token, or undefined at the end. */
export function channelNextPage(last: { continuation?: string | null } | undefined): string | undefined {
  return last?.continuation ? last.continuation : undefined;
}

/** Auto-retry delay for a failed page: 2 s, 4 s, 8 s… capped at 30 s. */
export function retryDelay(attempt: number, base = 2000, max = 30_000): number {
  if (!Number.isFinite(attempt) || attempt < 0) return base;
  return Math.min(max, base * 2 ** Math.min(attempt, 16));
}

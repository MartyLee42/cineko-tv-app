// Pure formatting for the three TV designs (Кинозал / Терминал / Проектор):
// title splitting, the data rows, release summaries for the auto-selected
// source, the status corner and the Терминал ticker. Unit-tested.
import type { Release } from "@martytv/contracts";
import { posterRating, ratingTone } from "@martytv/ui";
import { formatBytes } from "../player/format";

/** Release size with one decimal from GB up ("61,4 ГБ" / "61.4 GB"). */
export function sizeText(bytes: number, locale = "en"): string {
  const gb = bytes / 1024 ** 3;
  if (!isFinite(gb) || gb < 1) return formatBytes(bytes, locale);
  const s = gb >= 1024 ? (gb / 1024).toFixed(1) : gb.toFixed(1);
  const unit = gb >= 1024 ? (locale === "ru" ? "ТБ" : "TB") : locale === "ru" ? "ГБ" : "GB";
  return `${locale === "ru" ? s.replace(".", ",") : s} ${unit}`;
}

/** «Дюна: Часть вторая» → main «Дюна», sub «Часть вторая» (Проектор's two-line title). */
export function splitTitle(title: string): { main: string; sub: string | null } {
  const t = title.trim();
  const i = t.indexOf(":");
  if (i <= 0 || i >= t.length - 1) return { main: t, sub: null };
  const main = t.slice(0, i).trim();
  const sub = t.slice(i + 1).trim();
  return main && sub ? { main, sub } : { main: t, sub: null };
}

/** 21:47 (24 h, local time). */
export function clockText(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Index tag on Терминал posters / sections: 1 → "01". */
export function indexTag(i: number): string {
  return String(i).padStart(2, "0");
}

/** Remaining time as a clock: 1624 s → "27:04", 4000 s → "1:06:40". */
export function remainingClock(sec: number | null | undefined): string | null {
  if (sec === null || sec === undefined || !isFinite(sec) || sec < 0) return null;
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Runtime in minutes as Терминал's «ХРОН.»: 166 → "2:46", 45 → "0:45". */
export function runtimeClock(minutes: number | null | undefined): string | null {
  if (!minutes || minutes <= 0) return null;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Filled segments of a segmented bar (Терминал): never 0 for a started item, never all for an unfinished one. */
export function filledSegments(fraction: number | null | undefined, count: number): number {
  if (fraction === null || fraction === undefined || !isFinite(fraction) || fraction <= 0) return 0;
  if (fraction >= 1) return count;
  return Math.min(count - 1, Math.max(1, Math.round(fraction * count)));
}

/** Ruler ticks beside Терминал's hero poster (00/25/50/75/99) plus the current progress (highlighted). */
export function rulerMarks(percent: number | null): { value: number; label: string; current: boolean }[] {
  const base = [0, 25, 50, 75, 99];
  const marks = base.map((v) => ({ value: v, label: indexTag(v), current: false }));
  if (percent === null || !isFinite(percent)) return marks;
  const p = Math.max(1, Math.min(98, Math.round(percent)));
  const same = marks.find((m) => m.value === p);
  if (same) {
    same.current = true;
    return marks;
  }
  // A mark too close to the current one would overlap it.
  return [...marks.filter((m) => Math.abs(m.value - p) >= 6), { value: p, label: indexTag(p), current: true }].sort((a, b) => a.value - b.value);
}

// ---------------------------------------------------------------- ratings

export type RatingSource = "kp" | "imdb" | "tmdb";
export interface RatingsInput {
  rating: number | null;
  kp_rating?: number | null;
  imdb_rating?: number | null;
}

/** "8.4" (one decimal, dot). */
export function ratingText(v: number): string {
  return (Math.round(v * 10) / 10).toFixed(1);
}

/**
 * Every known rating, the primary one (the poster setting's source, falling
 * back kp → tmdb) first: [КП 8.5, IMDb 8.7, TMDB 8.2].
 */
export function ratingList(m: RatingsInput, primary: RatingSource | "off" = "kp"): { source: RatingSource; value: string }[] {
  const known: { source: RatingSource; v: number | null | undefined }[] = [
    { source: "kp", v: m.kp_rating },
    { source: "imdb", v: m.imdb_rating },
    { source: "tmdb", v: m.rating },
  ];
  const list = known.filter((k) => typeof k.v === "number" && k.v > 0).map((k) => ({ source: k.source, value: ratingText(k.v!) }));
  const order: RatingSource[] = primary === "imdb" ? ["imdb", "kp", "tmdb"] : primary === "tmdb" ? ["tmdb", "kp", "imdb"] : ["kp", "tmdb", "imdb"];
  const first = order.find((s) => list.some((r) => r.source === s));
  return first ? [list.find((r) => r.source === first)!, ...list.filter((r) => r.source !== first)] : list;
}

/**
 * The small rating badge in a poster's top-right corner: the setting's
 * source (falling back kp → tmdb), hidden when unknown or switched off.
 */
export function posterBadge(m: RatingsInput, setting: RatingSource | "off"): { text: string; tone: "good" | "mid" | "bad"; source: RatingSource } | null {
  const r = posterRating(m, setting);
  return r ? { text: ratingText(r.value), tone: ratingTone(r.value), source: r.source } : null;
}

export const RATING_LABEL: Record<RatingSource, string> = { kp: "КП", imdb: "IMDb", tmdb: "TMDB" };

// ---------------------------------------------------------------- releases

export type VoiceKind = "dub" | "mvo" | "dvo" | "avo" | "vo" | "original";

export interface ReleaseSummary {
  /** 2160p / 1080p / 720p / SD / null */
  quality: string | null;
  /** 4K / FHD… badge for Проектор (null below 1080p). */
  badge: string | null;
  hdr: string | null;
  /** Voice-over kind (translated by the caller), else null. */
  voice: VoiceKind | null;
  /** Voice-over studio when named (LostFilm…). */
  studio: string | null;
  /** Atmos / 7.1 / 5.1 / 2.0 / codec. */
  audio: string | null;
  size: string;
  seeders: number;
  tracker: string;
}

const HDR: Record<string, string> = { hdr10: "HDR10", hdr10plus: "HDR10+", dolby_vision: "Dolby Vision", hlg: "HLG" };
const ACODEC: Record<string, string> = { aac: "AAC", ac3: "AC3", eac3: "E-AC3", dts: "DTS", truehd: "TrueHD", flac: "FLAC", mp3: "MP3", opus: "Opus" };

/** Atmos / channel layout from the release title, else the first audio codec. */
export function audioLabel(r: Pick<Release, "title" | "audio_codecs">): string | null {
  const t = r.title;
  if (/atmos/i.test(t)) return "Atmos";
  const ch = /(?:^|[^\d.])([7521])[.,]([10])(?![\d])/.exec(t);
  if (ch && ["7.1", "5.1", "2.0", "1.0"].includes(`${ch[1]}.${ch[2]}`)) return `${ch[1]}.${ch[2]}`;
  const c = r.audio_codecs[0];
  return c ? (ACODEC[c.toLowerCase()] ?? c.toUpperCase()) : null;
}

export function summarizeRelease(r: Release, locale = "en"): ReleaseSummary {
  const res = r.resolution;
  const vo = (r.voiceovers ?? [])[0];
  const kind = vo?.kind ?? (vo?.language === "orig" ? "original" : null);
  return {
    quality: res === "576p" || res === "480p" ? "SD" : res,
    badge: res === "2160p" ? "4K" : res === "1080p" ? "FHD" : null,
    hdr: r.hdr ? (HDR[r.hdr] ?? r.hdr.toUpperCase()) : null,
    voice: kind,
    studio: vo?.studio ?? null,
    audio: audioLabel(r),
    size: sizeText(r.size_bytes, locale),
    seeders: r.seeders,
    tracker: r.indexer,
  };
}

// ---------------------------------------------------------------- status

export interface ServiceStatusLike {
  torrserver: { ok: boolean; latency_ms: number | null };
  prowlarr: { ok: boolean };
  active_streams: number;
}

/** The status corner / ticker's TorrServer state: unknown until the first answer. */
export function torrState(s: ServiceStatusLike | null | undefined): "online" | "offline" | "unknown" {
  if (!s) return "unknown";
  return s.torrserver.ok ? "online" : "offline";
}

/**
 * Терминал's ticker items (uppercased by the caller's font): the TV, the
 * server, streams now, the profile, unread messages. Labels come translated.
 */
export function tickerItems(input: {
  device: string | null;
  status: ServiceStatusLike | null | undefined;
  profile: string;
  unread: number;
  labels: {
    online: string;
    offline: string;
    torrserver: (ms: number | null) => string;
    torrserverDown: string;
    prowlarrDown: string;
    streams: (n: number) => string;
    profile: (name: string) => string;
    unread: (n: number) => string;
  };
}): string[] {
  const { device, status, labels } = input;
  const out: string[] = [];
  if (device) out.push(`● ${device} ${labels.online}`);
  if (status) {
    out.push(status.torrserver.ok ? labels.torrserver(status.torrserver.latency_ms) : labels.torrserverDown);
    if (!status.prowlarr.ok) out.push(labels.prowlarrDown);
    out.push(labels.streams(status.active_streams));
  }
  out.push(labels.profile(input.profile));
  if (input.unread > 0) out.push(labels.unread(input.unread));
  return out.map((s) => s.toUpperCase());
}

/** Ticker scroll duration (s): a constant reading speed whatever the length. */
export function tickerSeconds(text: string): number {
  return Math.max(20, Math.round(text.length * 0.32));
}

/** Russian plural form index (one / few / many) for counted labels. */
export function pluralRu(n: number): 0 | 1 | 2 {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 0;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 1;
  return 2;
}

/** Whole days between two instants in local time (0 = same calendar day). */
export function daysAgo(iso: string, now: Date): number {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 0;
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/** Initial for an avatar chip. */
export function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

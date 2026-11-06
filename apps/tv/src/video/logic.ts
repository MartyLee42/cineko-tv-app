// «Видео» (YouTube via Invidious) on the TV: pure helpers — card labels
// (duration, views, "2 days ago"), progress bars, where playback starts,
// the source to play on this engine and the realtime video.play payload.
// Unit-tested (logic.test.ts); no React, no DOM.
import type { Schemas } from "@martytv/contracts";

export type VideoItem = Schemas["VideoItem"];
export type VideoDetail = Schemas["VideoDetail"];
export type VideoProgress = Schemas["VideoProgress"];

/** A video the player / a route may know only by id (the rest arrives with the detail). */
export type VideoRef = Pick<VideoItem, "id"> & Partial<Omit<VideoItem, "id">>;

/** YouTube video ids (11 chars of [A-Za-z0-9_-]). */
export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export const QUALITIES = [480, 720, 1080] as const;
export type VideoQuality = (typeof QUALITIES)[number];
export const DEFAULT_QUALITY: VideoQuality = 720;

/** Below this position there's nothing worth resuming (the server lists ≥ 15 s). */
export const MIN_RESUME = 15;

/** 4:05 / 1:02:03 (null for live / unknown). */
export function formatDuration(sec: number | null | undefined): string | null {
  if (sec === null || sec === undefined || !isFinite(sec) || sec <= 0) return null;
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * Short count: 950, 15K / 15 тыс., 1.2M / 1,2 млн, 3B / 3 млрд. Written by
 * hand: Intl's compact notation is missing on old TV engines.
 */
export function compactCount(n: number, locale: string): string {
  const ru = locale === "ru";
  const abs = Math.abs(n);
  const fmt = (v: number) => {
    // One decimal below 10 (1,2 млн), whole numbers above (15 тыс.).
    const r = v < 10 ? Math.floor(v * 10) / 10 : Math.floor(v);
    const s = String(r);
    return ru ? s.replace(".", ",") : s;
  };
  if (abs >= 1e9) return ru ? `${fmt(n / 1e9)} млрд` : `${fmt(n / 1e9)}B`;
  if (abs >= 1e6) return ru ? `${fmt(n / 1e6)} млн` : `${fmt(n / 1e6)}M`;
  if (abs >= 1e3) return ru ? `${fmt(n / 1e3)} тыс.` : `${fmt(n / 1e3)}K`;
  return String(Math.floor(n));
}

/** Plural form for a counted label: the raw count below 1000, else "many" (15 тыс. просмотров). */
export function countForm(n: number, locale: string): "one" | "few" | "many" {
  if (n >= 1000) return "many";
  if (locale !== "ru") return n === 1 ? "one" : "many";
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "one";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "few";
  return "many";
}

export type AgoUnit = "now" | "hours" | "days" | "weeks" | "months" | "years";

/** "N <unit> ago" for a publish date (approximate, as YouTube gives it); null when unknown. */
export function ago(iso: string | null | undefined, now: number): { unit: AgoUnit; n: number } | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  const h = Math.max(0, (now - t) / 3_600_000);
  if (h < 1) return { unit: "now", n: 0 };
  if (h < 24) return { unit: "hours", n: Math.floor(h) };
  const d = Math.floor(h / 24);
  if (d < 7) return { unit: "days", n: d };
  if (d < 30) return { unit: "weeks", n: Math.floor(d / 7) };
  if (d < 365) return { unit: "months", n: Math.max(1, Math.floor(d / 30)) };
  return { unit: "years", n: Math.floor(d / 365) };
}

/** Progress bar fraction for a card (null: none / finished / too little to show). */
export function progressFraction(p: VideoProgress | null | undefined, duration?: number | null): number | null {
  if (!p || p.finished) return null;
  const dur = p.duration_seconds > 0 ? p.duration_seconds : (duration ?? 0);
  if (!dur || p.position_seconds <= 0) return null;
  return Math.max(0.02, Math.min(1, p.position_seconds / dur));
}

/** Where "Play" on Details starts: the saved position when it's worth resuming, else 0. */
export function resumeAt(p: VideoProgress | null | undefined): number | null {
  if (!p || p.finished) return null;
  if (!isFinite(p.position_seconds) || p.position_seconds < MIN_RESUME) return null;
  if (p.duration_seconds > 0 && p.position_seconds >= p.duration_seconds - 10) return null;
  return p.position_seconds;
}

/** Where the player starts: an explicit start, else the source's resume point, else 0. */
export function startPosition(explicit: number | null | undefined, source: number | null | undefined, duration: number | null | undefined): number {
  const at = explicit ?? source ?? 0;
  if (!isFinite(at) || at <= 0) return 0;
  // Never start inside the last seconds (would end at once).
  if (duration && duration > 0 && at >= duration - 5) return 0;
  return at;
}

/** Why a video can't be played on Details (null = playable). */
export function blockReason(v: Pick<VideoDetail, "live" | "upcoming" | "playable"> | Pick<VideoItem, "live" | "upcoming">): "live" | "unplayable" | null {
  if (v.live || v.upcoming) return "live";
  if ("playable" in v && v.playable === false) return "unplayable";
  return null;
}

export type PlayMode = "hls-native" | "hls-js" | "mp4";

/**
 * What this engine plays: HLS (natively or through hls.js), else the
 * progressive MP4 fallback; `null` when nothing can play.
 * `hls` = streamMode() of stream.ts (native / hlsjs / none).
 */
export function pickPlay(
  src: { format?: string | null; stream_url?: string | null; fallback_url?: string | null },
  hls: "native" | "hlsjs" | "none",
  hlsFailed: boolean,
): { mode: PlayMode; url: string } | null {
  if (src.stream_url && src.format === "mp4") return { mode: "mp4", url: src.stream_url };
  if (src.stream_url && !hlsFailed && hls !== "none") return { mode: hls === "native" ? "hls-native" : "hls-js", url: src.stream_url };
  return src.fallback_url ? { mode: "mp4", url: src.fallback_url } : null;
}

/** Report progress every this often while playing. */
export const PROGRESS_EVERY = 10_000;

/** Whether a position is worth a progress report (something played, values sane). */
export function reportable(position: number, duration: number | null | undefined): boolean {
  if (!isFinite(position) || position < 1) return false;
  return !(duration !== null && duration !== undefined && isFinite(duration) && duration > 0 && position > duration + 5);
}

/** The next/previous video in a list (wraps around; null when there's nothing else). */
export function stepVideo<T extends { id: string }>(list: readonly T[], currentId: string, dir: 1 | -1): T | null {
  const others = list.filter((v) => v.id !== currentId);
  if (others.length === 0) return null;
  const i = list.findIndex((v) => v.id === currentId);
  if (i < 0) return dir > 0 ? list[0]! : list[list.length - 1]!;
  return list[(i + dir + list.length) % list.length]!;
}

/** Quality menu entries: the source's heights capped at 1080, highest first. */
export function qualityList(qualities: readonly number[] | null | undefined): number[] {
  return [...new Set((qualities ?? []).filter((q) => q > 0 && q <= 1080))].sort((a, b) => b - a);
}

/** The profile's quality setting, sanitized. */
export function profileQuality(v: unknown): VideoQuality {
  return (QUALITIES as readonly unknown[]).includes(v) ? (v as VideoQuality) : DEFAULT_QUALITY;
}

/** Rows of the «Видео» tab, in order; empty personal rows are left out (Подписки always shows). */
export type RowId = "continue" | "subscriptions" | "trending" | "watch_later" | "history";

export function tabRows(data: Record<RowId, readonly VideoItem[] | undefined>): RowId[] {
  const out: RowId[] = [];
  if ((data.continue?.length ?? 0) > 0) out.push("continue");
  out.push("subscriptions");
  out.push("trending");
  if ((data.watch_later?.length ?? 0) > 0) out.push("watch_later");
  if ((data.history?.length ?? 0) > 0) out.push("history");
  return out;
}

/** Drops videos that are already in «Продолжить» from a list (no duplicates side by side). */
export function withoutIds(items: readonly VideoItem[], ids: ReadonlySet<string>): VideoItem[] {
  return items.filter((v) => !ids.has(v.id));
}

/** A validated video.play (phone → TV). */
export interface VideoPlayRequest {
  video_id: string;
  profile_id?: string;
  position_seconds?: number;
  quality?: VideoQuality;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const none = (v: unknown) => v === undefined || v === null;

/** Validates a video.play payload (the server validates too; be defensive). */
export function parseVideoPlay(p: unknown): (VideoPlayRequest & { force: boolean }) | null {
  if (typeof p !== "object" || p === null || Array.isArray(p)) return null;
  const { video_id, profile_id, position_seconds, quality, force } = p as Record<string, unknown>;
  if (typeof video_id !== "string" || !VIDEO_ID.test(video_id)) return null;
  if (!none(profile_id) && (typeof profile_id !== "string" || !UUID.test(profile_id))) return null;
  if (!none(position_seconds) && (typeof position_seconds !== "number" || !isFinite(position_seconds) || position_seconds < 0 || position_seconds >= 1e6)) return null;
  if (!none(quality) && !(QUALITIES as readonly unknown[]).includes(quality)) return null;
  if (!none(force) && typeof force !== "boolean") return null;
  const req: VideoPlayRequest & { force: boolean } = { video_id, force: force === true };
  if (typeof profile_id === "string") req.profile_id = profile_id.toLowerCase();
  if (typeof position_seconds === "number") req.position_seconds = position_seconds;
  if (typeof quality === "number") req.quality = quality as VideoQuality;
  return req;
}

// ---------------------------------------------------------------- lists: paging and errors

/** Feed entries per «Подписки» page (GET /video/feed offset/limit). */
export const FEED_PAGE = 50;
/** Search pages the TV loads at most (the server allows 20). */
export const SEARCH_PAGES = 20;
/** Load the next page when focus is this many items from the end. */
export const PREFETCH = 8;

/** The feed's next offset (null = the last page). Older servers send no next_offset: one page only. */
export function feedNextOffset(last: { next_offset?: number | null }): number | undefined {
  return typeof last.next_offset === "number" && last.next_offset > 0 ? last.next_offset : undefined;
}

/** The next search page (undefined = done): an empty page or the TV's cap ends it. */
export function searchNextPage(last: { page: number; videos: readonly unknown[] }, max = SEARCH_PAGES): number | undefined {
  return last.videos.length > 0 && last.page < max ? last.page + 1 : undefined;
}

/** A channel's next uploads page (its continuation token). */
export function channelNext(last: { continuation?: string | null }): string | undefined {
  return last.continuation ? last.continuation : undefined;
}

/**
 * Whether focus at `index` should load the next page now: close to the end,
 * there is one, nothing is in flight, and the last attempt didn't fail (a
 * failed page is retried by the backoff, not by every key press).
 */
export function wantsMore(index: number, count: number, s: { hasNext: boolean; fetching: boolean; failed: boolean }, threshold = PREFETCH): boolean {
  return s.hasNext && !s.fetching && !s.failed && count > 0 && index >= count - threshold;
}

/** Automatic retry after a failed load: 5 s, 10 s, 20 s, 40 s, then every 60 s. */
export function retryDelay(attempt: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, Math.min(attempt, 10)));
}

/** List items without repeats (pages can overlap when the feed changes between them). */
export function dedupeById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const v of items) {
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------- remote: what the phone sees

export type VideoFailure = "unavailable" | "live" | "unplayable" | "failed";

/** What the mounted player knows, for DeviceState.video. */
export interface VideoPlayerInfo {
  title: string | null;
  channel_id: string | null;
  channel_name: string | null;
  position: number;
  duration: number | null;
  paused: boolean;
  buffering: boolean;
  quality: number | null;
  qualities: readonly number[];
  volume: number | null;
  error: VideoFailure | null;
}

export type VideoPlaybackState = Schemas["VideoPlaybackState"];

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * DeviceState.video for the phone's remote: the session's video (title,
 * channel, thumbnail from the card it was opened from) overlaid with the
 * player's live values. Positions are whole seconds so identical states
 * aren't re-sent while paused.
 */
export function videoPlaybackState(video: VideoRef, info: VideoPlayerInfo | null): VideoPlaybackState {
  const dur = info?.duration ?? video.duration_seconds ?? null;
  return {
    video_id: video.id,
    title: info?.title || video.title || null,
    channel_id: info?.channel_id || video.channel_id || null,
    channel_name: info?.channel_name || video.channel_name || null,
    thumbnail: video.thumbnail || `/api/v1/video/thumbs/vi/${video.id}/mqdefault.jpg`,
    position_seconds: info ? Math.max(0, Math.floor(info.position)) : 0,
    duration_seconds: dur !== null && isFinite(dur) && dur > 0 ? round1(dur) : null,
    paused: info ? info.paused : false,
    buffering: info ? info.buffering : true,
    quality: info?.quality ?? null,
    qualities: [...(info?.qualities ?? [])],
    volume: info?.volume === null || info?.volume === undefined ? null : Math.round(info.volume * 100) / 100,
    error: info?.error ?? null,
  };
}

/** The first related video that can play here («Следующее видео», media.next_episode). */
export function nextRelated<T extends Pick<VideoItem, "id" | "live" | "upcoming">>(related: readonly T[], currentId: string): T | null {
  return related.find((v) => v.id !== currentId && !blockReason(v)) ?? null;
}

/**
 * Whether the «Видео» tab replaces its rows with a full error: only when
 * nothing at all is on screen (no row has cards) and «Подписки» or «В
 * тренде» failed. A failed (re)load with cards on screen keeps them — and
 * the focus — and only says so.
 */
export function fullTabError(pending: boolean, rowsWithCards: number, failed: readonly RowId[]): boolean {
  return !pending && rowsWithCards === 0 && failed.some((r) => r === "subscriptions" || r === "trending");
}

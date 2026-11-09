// Pure player logic (no React, no DOM): first-load progress, where to start,
// control-bar visibility, keyboard and touch mapping, buffered ranges, the
// next episode. Unit-tested in player.test.ts.
import type { PlaybackSource, Release, WatchProgress } from "@martytv/contracts";

// ---------------------------------------------------------------- first load

//   finding a release / creating the source   0    → 0.15
//   TorrServer fetching metadata               0.15 → 0.35
//   preloading (preloaded_bytes vs a target)   0.35 → 0.85
//   stream ready → first frame (canplay)       0.85 → 1
export type LoadStage = "resolving" | "creating" | "metadata" | "preloading" | "starting" | "done";

export const STAGE_RANGE: Record<LoadStage, [number, number]> = {
  resolving: [0, 0.1],
  creating: [0.08, 0.15],
  metadata: [0.15, 0.35],
  preloading: [0.35, 0.85],
  starting: [0.85, 1],
  done: [1, 1],
};

const MB = 1024 * 1024;

/** Bytes to preload before playback is likely smooth: 2% of the file, 16–32 MB. */
export function preloadTarget(fileBytes: number | null | undefined): number {
  const f = fileBytes && fileBytes > 0 ? fileBytes : 0;
  return Math.min(32 * MB, Math.max(16 * MB, f * 0.02));
}

function creep(ms: number, half: number): number {
  return 1 - Math.pow(0.5, Math.max(0, ms) / half);
}

/** Stage from the page step and the (polled) source. */
export function stageOf(step: "resolving" | "creating" | "source", source: Pick<PlaybackSource, "torrent" | "status"> | null): LoadStage {
  if (step === "resolving") return "resolving";
  if (step === "creating" || !source) return "creating";
  if (source.status === "ready") return "starting";
  const t = source.torrent;
  return !t || (t.preloaded_bytes ?? 0) <= 0 ? "metadata" : "preloading";
}

export interface LoadInput {
  stage: LoadStage;
  stageMs: number;
  source?: Pick<PlaybackSource, "torrent" | "file" | "release"> | null;
  /** The <video> has loaded metadata. */
  metadata?: boolean;
}

/** Raw progress for the current stage (made monotonic by LoadMeter). */
export function rawProgress(i: LoadInput): number {
  const [a, b] = STAGE_RANGE[i.stage];
  const span = b - a;
  switch (i.stage) {
    case "done":
      return 1;
    case "preloading": {
      const size = i.source?.file?.size_bytes ?? i.source?.release?.size_bytes ?? null;
      const got = i.source?.torrent?.preloaded_bytes ?? 0;
      return a + span * Math.min(1, got / preloadTarget(size));
    }
    case "starting":
      return a + span * (i.metadata ? 0.6 + 0.35 * creep(i.stageMs, 1500) : 0.55 * creep(i.stageMs, 2500));
    default:
      // No measurable progress: creep towards the stage's end without reaching it.
      return a + span * 0.92 * creep(i.stageMs, i.stage === "metadata" ? 6000 : 2500);
  }
}

/** Keeps the shown value monotonic. */
export class LoadMeter {
  private value = 0;
  update(raw: number): number {
    if (Number.isFinite(raw)) this.value = Math.min(1, Math.max(this.value, raw));
    return this.value;
  }
  reset() {
    this.value = 0;
  }
}

const STAGE_ORDER: LoadStage[] = ["resolving", "creating", "metadata", "preloading", "starting", "done"];

/**
 * One load's progress: monotonic (LoadMeter), and the stage never moves back
 * (a poll without torrent stats turns "preloading" into "metadata"; the creep
 * would restart). Another source id (not the first one appearing) starts over.
 */
export class LoadTracker {
  private sourceId: string | null = null;
  private meter = new LoadMeter();
  private stage: LoadStage | null = null;
  private stageAt = 0;

  update(i: Omit<LoadInput, "stageMs"> & { sourceId?: string | null }, now: number): number {
    const sid = i.sourceId ?? null;
    if (sid !== null && this.sourceId !== null && sid !== this.sourceId) {
      this.meter.reset();
      this.stage = null;
    }
    if (sid !== null) this.sourceId = sid;
    if (this.stage === null || STAGE_ORDER.indexOf(i.stage) > STAGE_ORDER.indexOf(this.stage)) {
      this.stage = i.stage;
      this.stageAt = now;
    }
    return this.meter.update(rawProgress({ stage: this.stage, stageMs: now - this.stageAt, source: i.source, metadata: i.metadata }));
  }
}

// ---------------------------------------------------------------- where to start

export const MIN_RESUME = 30;

export type StartDecision =
  /** Play from `at` without asking. */
  | { kind: "start"; at: number }
  /** Ask "Resume at … / Start over" before starting. */
  | { kind: "ask"; at: number };

/**
 * `t` from the URL wins (the title page already asked: Resume / Start over /
 * Watch again). Otherwise an unfinished item ≥ 30 s in asks; anything else
 * starts at 0.
 */
export function decideStart(t: number | null, progress: Pick<WatchProgress, "position_seconds" | "duration_seconds" | "completed"> | null | undefined): StartDecision {
  if (t != null && Number.isFinite(t) && t >= 0) return { kind: "start", at: t };
  if (!progress || progress.completed) return { kind: "start", at: 0 };
  const at = progress.position_seconds;
  if (!Number.isFinite(at) || at < MIN_RESUME) return { kind: "start", at: 0 };
  if (progress.duration_seconds && at >= progress.duration_seconds - 5) return { kind: "start", at: 0 };
  return { kind: "ask", at };
}

/**
 * When the progress wasn't known before starting (request failed), the
 * session's resume point is applied once — only near the start.
 */
export function lateResume(decided: boolean, sessionResume: number | null | undefined, currentTime: number): number | null {
  if (decided || sessionResume == null || sessionResume < MIN_RESUME) return null;
  return currentTime < 10 ? sessionResume : null;
}

/** "t" query parameter → seconds (null when absent or invalid). */
export function parseT(v: string | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ---------------------------------------------------------------- controls

export const HIDE_AFTER = 3000;
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export const SEEK_BACK = -10;
export const SEEK_FORWARD = 30;

export type Menu = "speed" | "audio" | "subs" | "quality" | "download" | null;

/**
 * Switching an online source's quality loads a new stream URL: continue from
 * the current spot, playing only if it was playing (an ended video restarts
 * from where it ended rather than replaying).
 */
export function qualityReload(v: { currentTime: number; paused: boolean; ended: boolean } | null, fallback: number): { at: number; play: boolean } {
  if (!v) return { at: Math.max(0, fallback), play: true };
  return { at: Math.max(0, v.currentTime || fallback), play: !v.paused && !v.ended };
}

/** A new stream URL that differs from the current one (forces the engine to reload). */
export function reloadUrl(next: string, current: string, quality: number): string {
  if (next !== current) return next;
  return `${next}${next.includes("?") ? "&" : "?"}q=${quality}`;
}

export interface ControlsState {
  visible: boolean;
  menu: Menu;
  /** Last user activity (ms). */
  at: number;
}

export type ControlsAction =
  | { type: "activity"; now: number }
  | { type: "toggle"; now: number }
  | { type: "menu"; menu: Menu; now: number }
  | { type: "tick"; now: number; playing: boolean; busy: boolean };

export const CONTROLS_INIT: ControlsState = { visible: true, menu: null, at: 0 };

/**
 * Controls show on activity and hide 3 s after it while playing; they never
 * hide while paused, while a menu is open or while the user scrubs.
 */
export function controlsReducer(s: ControlsState, a: ControlsAction): ControlsState {
  switch (a.type) {
    case "activity":
      return s.visible && a.now - s.at < 250 ? s : { ...s, visible: true, at: a.now };
    case "toggle":
      return s.visible ? { ...s, visible: false, menu: null } : { ...s, visible: true, at: a.now };
    case "menu":
      return { ...s, visible: true, menu: s.menu === a.menu ? null : a.menu, at: a.now };
    case "tick":
      if (!s.visible || !a.playing || a.busy || s.menu) return s;
      return a.now - s.at >= HIDE_AFTER ? { ...s, visible: false } : s;
  }
}

export type KeyCommand =
  | { type: "toggle" }
  | { type: "seek"; delta: number }
  | { type: "volume"; delta: number }
  | { type: "mute" }
  | { type: "fullscreen" };

/** Keyboard shortcuts: Space/K, ←/J, →/L, ↑/↓, F, M. */
export function keyCommand(key: string): KeyCommand | null {
  switch (key) {
    case " ":
    case "k":
    case "K":
    case "MediaPlayPause":
      return { type: "toggle" };
    case "ArrowLeft":
    case "j":
    case "J":
      return { type: "seek", delta: SEEK_BACK };
    case "ArrowRight":
    case "l":
    case "L":
      return { type: "seek", delta: SEEK_FORWARD };
    case "ArrowUp":
      return { type: "volume", delta: 0.1 };
    case "ArrowDown":
      return { type: "volume", delta: -0.1 };
    case "m":
    case "M":
      return { type: "mute" };
    case "f":
    case "F":
      return { type: "fullscreen" };
    default:
      return null;
  }
}

export type TapZone = "left" | "center" | "right";

/** Which third of the video a tap hit. */
export function tapZone(x: number, width: number): TapZone {
  if (width <= 0) return "center";
  const f = x / width;
  return f < 1 / 3 ? "left" : f > 2 / 3 ? "right" : "center";
}

export const DOUBLE_TAP_MS = 300;

export interface Tap {
  t: number;
  zone: TapZone;
}

/**
 * Double tap on the left/right third seeks; anything else is a single tap
 * (toggles the controls). Further taps in a burst keep seeking.
 */
export function classifyTap(prev: Tap | null, now: Tap): "double" | "single" {
  if (!prev || now.zone === "center" || prev.zone !== now.zone) return "single";
  return now.t - prev.t <= DOUBLE_TAP_MS ? "double" : "single";
}

/** Clamped seek target for a relative jump. */
export function seekBy(position: number, delta: number, duration: number | null | undefined): number {
  const max = duration && Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  return Math.max(0, Math.min(max, position + delta));
}

/** Buffered ranges as percentages of the duration for the seek bar. */
export function bufferedSegments(ranges: readonly [number, number][], duration: number | null | undefined): { left: number; width: number }[] {
  if (!duration || !Number.isFinite(duration) || duration <= 0) return [];
  return ranges
    .map(([a, b]) => {
      const left = Math.max(0, Math.min(1, a / duration));
      const right = Math.max(0, Math.min(1, b / duration));
      return { left: left * 100, width: Math.max(0, right - left) * 100 };
    })
    .filter((s) => s.width > 0);
}

export function clampVolume(v: number): number {
  return Math.max(0, Math.min(1, Math.round(v * 100) / 100));
}

// ---------------------------------------------------------------- no sound

export interface AudioProbe {
  /** Safari: AudioTrackList length. */
  audioTracks?: number;
  /** Chrome: bytes of audio decoded so far. */
  webkitAudioDecodedByteCount?: number;
  /** Firefox. */
  mozHasAudio?: boolean;
}

/**
 * After a few seconds of playback: true when the engine reports no decoded
 * audio although the file has some; null when it can't tell.
 */
export function silentPlayback(p: AudioProbe): boolean | null {
  if (typeof p.mozHasAudio === "boolean") return !p.mozHasAudio;
  if (typeof p.webkitAudioDecodedByteCount === "number") return p.webkitAudioDecodedByteCount === 0;
  if (typeof p.audioTracks === "number") return p.audioTracks === 0;
  return null;
}

/**
 * ffprobe runs in the background once a torrent source is ready and takes
 * long on a fresh torrent (TorrServer fetches the headers first; one try per
 * 2 min, ≤ 45 s each). Delay before refetching the source for the n-th time
 * (0-based) while it has no media_info; null = give up (~6 min).
 */
const INFO_REFETCH_MS = [2500, 4000, 6000, 10_000, 15_000, 20_000, 30_000, 30_000, 30_000, 45_000, 60_000, 60_000, 60_000];

export function infoRefetchDelay(n: number): number | null {
  return INFO_REFETCH_MS[n] ?? null;
}

// ---------------------------------------------------------------- errors

export type ErrorKind = "unsupported" | "decode" | "network" | "aborted";

/** MediaError.code → what to do about it. */
export function mediaErrorKind(code: number | null | undefined): ErrorKind {
  if (code === 4) return "unsupported";
  if (code === 3) return "decode";
  if (code === 1) return "aborted";
  return "network";
}

/** Whether a stream URL is about to expire (refresh it before reloading). */
export function streamExpired(expiresAt: string | null | undefined, now = Date.now(), marginMs = 60_000): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t - marginMs <= now;
}

// ---------------------------------------------------------------- next episode

export interface EpisodeLike {
  id: string;
  season_number: number;
  episode_number: number;
  name?: string | null;
  air_date?: string | null;
}

export interface EpisodeRef {
  season: number;
  episode: number;
  id?: string;
  name?: string | null;
}

const aired = (e: EpisodeLike, today: string) => !e.air_date || e.air_date <= today;

/**
 * The episode after `cur`: the next aired one in the same season, else the
 * first aired one of the next regular season (its list when known).
 * Specials (season 0) never roll over.
 */
export function nextEpisode(
  cur: { season: number; episode: number },
  seasonEpisodes: readonly EpisodeLike[] | undefined,
  seasons: readonly { season_number: number; air_date?: string | null; episode_count?: number }[],
  nextSeasonEpisodes?: readonly EpisodeLike[],
  today = new Date().toISOString().slice(0, 10),
): EpisodeRef | null {
  if (seasonEpisodes) {
    const after = seasonEpisodes
      .filter((e) => e.season_number === cur.season && e.episode_number > cur.episode)
      .sort((a, b) => a.episode_number - b.episode_number)[0];
    if (after) return aired(after, today) ? { season: after.season_number, episode: after.episode_number, id: after.id, name: after.name } : null;
  }
  if (cur.season === 0) return null;
  const next = seasons
    .filter((s) => s.season_number > cur.season && (s.episode_count === undefined || s.episode_count > 0))
    .sort((a, b) => a.season_number - b.season_number)[0];
  if (!next || (next.air_date && next.air_date > today)) return null;
  if (nextSeasonEpisodes) {
    const first = nextSeasonEpisodes.filter((e) => e.season_number === next.season_number).sort((a, b) => a.episode_number - b.episode_number)[0];
    if (!first || !aired(first, today)) return null;
    return { season: first.season_number, episode: first.episode_number, id: first.id, name: first.name };
  }
  return { season: next.season_number, episode: 1 };
}

/**
 * The episode before `cur`: the previous one in the same season, else the
 * last episode of the previous regular season (its list when known).
 * Specials (season 0) never roll back into regular seasons.
 */
export function prevEpisode(
  cur: { season: number; episode: number },
  seasonEpisodes: readonly EpisodeLike[] | undefined,
  seasons: readonly { season_number: number; episode_count?: number }[],
  prevSeasonEpisodes?: readonly EpisodeLike[],
): EpisodeRef | null {
  if (seasonEpisodes) {
    const before = seasonEpisodes
      .filter((e) => e.season_number === cur.season && e.episode_number < cur.episode)
      .sort((a, b) => b.episode_number - a.episode_number)[0];
    if (before) return { season: before.season_number, episode: before.episode_number, id: before.id, name: before.name };
  } else if (cur.episode > 1) {
    return { season: cur.season, episode: cur.episode - 1 };
  }
  if (cur.season <= 1) return null;
  const prev = seasons
    .filter((s) => s.season_number > 0 && s.season_number < cur.season && (s.episode_count === undefined || s.episode_count > 0))
    .sort((a, b) => b.season_number - a.season_number)[0];
  if (!prev) return null;
  if (prevSeasonEpisodes) {
    const last = prevSeasonEpisodes.filter((e) => e.season_number === prev.season_number).sort((a, b) => b.episode_number - a.episode_number)[0];
    return last ? { season: last.season_number, episode: last.episode_number, id: last.id, name: last.name } : null;
  }
  return prev.episode_count ? { season: prev.season_number, episode: prev.episode_count } : null;
}

/** Whether a season-pack release also has `episode` (same release, new source). */
export function packCovers(r: Pick<Release, "is_season_pack" | "seasons" | "episodes">, season: number, episode: number): boolean {
  if (!r.is_season_pack) return false;
  if (r.seasons.length > 0 && !r.seasons.includes(season)) return false;
  if (r.episodes.length > 0 && !r.episodes.includes(episode)) return false;
  return true;
}

export const NEXT_COUNTDOWN = 10;

// ---------------------------------------------------------------- URLs

export interface WatchTarget {
  media_id: string;
  episode_id?: string | null;
  season_number?: number | null;
  episode_number?: number | null;
}

/**
 * Player URL. `sourceId` "new" = find/prepare a release first (`release`
 * picks one; omitted → the best one for this browser).
 */
export function watchUrl(target: WatchTarget, opts: { sourceId?: string; release?: string; t?: number | null; attempt?: number } = {}): string {
  const q = new URLSearchParams({ media: target.media_id });
  if (target.episode_id) q.set("episode", target.episode_id);
  if (target.season_number != null) q.set("s", String(target.season_number));
  if (target.episode_number != null) q.set("e", String(target.episode_number));
  if (opts.release) q.set("release", opts.release);
  if (opts.t != null && Number.isFinite(opts.t)) q.set("t", String(Math.max(0, Math.floor(opts.t))));
  if (opts.attempt) q.set("try", String(opts.attempt));
  return `/watch/${encodeURIComponent(opts.sourceId ?? "new")}?${q.toString()}`;
}

// ---------------------------------------------------------------- rebuffering

/**
 * Rebuffering to a threshold. Browsers resume the moment a sliver of data
 * arrives and stall again ("2 s play → loading → …") when the connection is
 * barely faster than the file. After a stall the player pauses internally
 * and resumes only once enough is buffered ahead (TVs' native players do
 * the same).
 */
export const REBUFFER_MIN = 20;
export const REBUFFER_MAX = 60;
export const REBUFFER_AFTER_SEEK = 8;

/** Seconds to have buffered ahead before resuming: max(20, 3 × last stall) ≤ 60; ~8 after a seek. */
export function rebufferTarget(lastStallSeconds: number | null | undefined, afterSeek: boolean): number {
  if (afterSeek) return REBUFFER_AFTER_SEEK;
  return Math.min(REBUFFER_MAX, Math.max(REBUFFER_MIN, 3 * (lastStallSeconds ?? 0)));
}

/** Seconds buffered ahead of `t` (the range containing t; 0 when t isn't buffered). */
export function bufferedAhead(ranges: readonly [number, number][], t: number): number {
  for (const [a, b] of ranges) if (t >= a - 0.25 && t <= b) return Math.max(0, b - t);
  return 0;
}

export type ResumeReason = "threshold" | "canplaythrough" | "end" | "plateau";

/** The buffered end hasn't grown for this long: the browser stopped fetching. */
export const PLATEAU_MS = 5_000;
/** …with at least this much (or the whole target) buffered: play it. */
export const PLATEAU_MIN_AHEAD = 4;

/**
 * Whether a rebuffer is over, and why. `end`: the buffer reaches the end of
 * the file. `plateau`: a paused browser stopped fetching below the target
 * (Android caps what a paused stream preloads) — «99 %» forever otherwise.
 * `stuckMs`: since the buffered end last grew.
 */
export function rebufferDone(o: {
  ahead: number;
  target: number;
  canPlayThrough: boolean;
  time: number;
  duration: number | null | undefined;
  stuckMs?: number;
}): ResumeReason | null {
  if (o.duration && o.duration > 0 && o.time + o.ahead >= o.duration - 0.5) return "end";
  if (o.ahead >= o.target) return "threshold";
  if (o.canPlayThrough) return "canplaythrough";
  if ((o.stuckMs ?? 0) >= PLATEAU_MS && o.ahead >= Math.min(PLATEAU_MIN_AHEAD, o.target)) return "plateau";
  return null;
}

/** «Буферизация… N%»: progress towards the target (0–99 until done). */
export function rebufferPercent(ahead: number, target: number): number {
  if (target <= 0) return 99;
  return Math.max(0, Math.min(99, Math.floor((ahead / target) * 100)));
}

// ---------------------------------------------------------------- bandwidth

/** Average bitrate of the file (bits/s): size × 8 / duration. */
export function sourceBitrate(sizeBytes: number | null | undefined, durationSeconds: number | null | undefined): number | null {
  if (!sizeBytes || !durationSeconds || sizeBytes <= 0 || durationSeconds <= 0) return null;
  return (sizeBytes * 8) / durationSeconds;
}

/** One observation of the buffer's end: wall time (ms) and media time (s). */
export interface RateSample {
  at: number;
  end: number;
}

/**
 * Effective download rate (bits/s) from how fast the buffered end grows:
 * media seconds gained per wall second × the file's bitrate, over the last
 * `windowMs`. Only feed samples while the browser is fetching (not with a
 * full buffer), else the rate reads low. Null until ≥ 3 s of samples.
 */
export function estimateRate(samples: readonly RateSample[], bitrate: number | null, now: number, windowMs = 15_000): number | null {
  if (!bitrate) return null;
  const recent = samples.filter((s) => s.at >= now - windowMs);
  if (recent.length < 2) return null;
  const first = recent[0]!;
  const last = recent[recent.length - 1]!;
  const dt = (last.at - first.at) / 1000;
  if (dt < 3) return null;
  return (Math.max(0, last.end - first.end) / dt) * bitrate;
}

export interface BandwidthState {
  /** Since when the rate has been below 1.1 × bitrate (ms), or null. */
  lowSince: number | null;
  /** Show «Скорость соединения ниже…». */
  hint: boolean;
}

export const LOW_RATE_FACTOR = 1.1;
export const LOW_RATE_FOR = 20_000;
export const STALL_WINDOW = 120_000;
export const STALLS_FOR_HINT = 3;

/** The lighter-release hint: rate < 1.1 × bitrate for > 20 s, or > 3 stalls in 2 min. */
export function bandwidthCheck(o: { rate: number | null; bitrate: number | null; lowSince: number | null; stalls: readonly number[]; now: number }): BandwidthState {
  const low = o.rate != null && o.bitrate != null && o.rate < LOW_RATE_FACTOR * o.bitrate;
  const lowSince = low ? (o.lowSince ?? o.now) : null;
  const recentStalls = o.stalls.filter((t) => t > o.now - STALL_WINDOW).length;
  return { lowSince, hint: (lowSince != null && o.now - lowSince > LOW_RATE_FOR) || recentStalls > STALLS_FOR_HINT };
}

/** Megabits with one decimal for the hint ("≈7.4 of 9.3 Mbit/s"). */
export function mbit(bps: number | null | undefined): string {
  return bps == null ? "?" : (Math.round(bps / 100_000) / 10).toFixed(1);
}

/**
 * Release list in "lighter release" mode: releases whose average bitrate
 * (size × 8 / duration) fits the measured rate come first, in their order;
 * then the rest (season packs and unknown sizes count as not fitting).
 */
export function preferUnderRate<R extends { size_bytes: number; is_season_pack?: boolean }>(items: readonly R[], rateBps: number, durationSeconds: number): R[] {
  const fits = (r: R) => !r.is_season_pack && r.size_bytes > 0 && (r.size_bytes * 8) / durationSeconds < rateBps * 0.9;
  return [...items.filter(fits), ...items.filter((r) => !fits(r))];
}

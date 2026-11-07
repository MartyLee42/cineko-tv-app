// Pure watch-progress decisions: resume or start over, which episode Details
// suggests, how a progress bar and "time left" read. Unit-tested.
import type { MediaProgress, NextUp, WatchProgress } from "@martytv/contracts";

/** Below this position there is nothing worth resuming. */
export const MIN_RESUME = 30;

export type ResumeChoice =
  /** In progress: offer "Resume at … / Start over" (Resume focused). */
  | { kind: "resume"; at: number }
  /** Finished: "Watch again" starts from 0. */
  | { kind: "again" }
  /** Nothing yet: play from the start. */
  | { kind: "start" };

export function resumeChoice(p: Pick<WatchProgress, "position_seconds" | "duration_seconds" | "completed"> | null | undefined): ResumeChoice {
  if (!p) return { kind: "start" };
  if (p.completed) return { kind: "again" };
  const at = p.position_seconds;
  if (!isFinite(at) || at < MIN_RESUME) return { kind: "start" };
  // Too close to the end to be worth resuming (and the server didn't mark it).
  if (p.duration_seconds && at >= p.duration_seconds - 5) return { kind: "again" };
  return { kind: "resume", at };
}

/** Progress of one episode (null when it has none). */
export function episodeProgress(mp: MediaProgress | null | undefined, episodeId: string): WatchProgress | null {
  return mp?.episodes.find((e) => e.episode_id === episodeId) ?? null;
}

export interface SeasonCount {
  completed: number;
  total: number;
}

/** "5/10" data for a season chip (null without progress data or episodes). */
export function seasonCount(mp: MediaProgress | null | undefined, season: number): SeasonCount | null {
  const s = mp?.seasons.find((x) => x.season_number === season);
  return s && s.total > 0 ? { completed: s.completed, total: s.total } : null;
}

/**
 * The episode Details suggests ("Next up"): the server's next_up, else the
 * most recently watched in-progress episode, else none.
 */
export function suggestedEpisode(mp: MediaProgress | null | undefined): { season: number; episode: number; id: string } | null {
  if (!mp) return null;
  const n: NextUp | null = mp.next_up;
  if (n) return { season: n.season_number, episode: n.episode_number, id: n.episode_id };
  const open = mp.episodes
    .filter((e) => !e.completed && e.episode_id && e.season_number !== null && e.episode_number !== null)
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
  return open ? { season: open.season_number!, episode: open.episode_number!, id: open.episode_id! } : null;
}

/**
 * Index to focus in a season's episode list: the remembered one, else the
 * requested (phone) one, else the suggested one when it is in this season,
 * else the first.
 */
export function focusEpisodeIndex(
  episodes: readonly { id: string; episode_number: number }[],
  opts: { remembered?: number; requested?: number; suggestedId?: string | null },
): number {
  if (opts.remembered !== undefined && opts.remembered >= 0 && opts.remembered < episodes.length) return opts.remembered;
  if (opts.requested !== undefined) {
    const i = episodes.findIndex((e) => e.episode_number === opts.requested);
    if (i >= 0) return i;
  }
  if (opts.suggestedId) {
    const i = episodes.findIndex((e) => e.id === opts.suggestedId);
    if (i >= 0) return i;
  }
  return 0;
}

/** Bar fraction 0..1 for a card (null hides the bar). */
export function barFraction(p: number | null | undefined): number | null {
  if (p === null || p === undefined || !isFinite(p) || p <= 0) return null;
  return Math.min(1, p);
}

/** Seconds left (null when the duration is unknown). */
export function timeLeft(p: Pick<WatchProgress, "position_seconds" | "duration_seconds">): number | null {
  if (!p.duration_seconds) return null;
  return Math.max(0, p.duration_seconds - p.position_seconds);
}

/** "1 h 12 min" / "12 min" / "45 s" (compact, locale units). */
export function formatLeft(sec: number, locale: string): string {
  const ru = locale !== "en";
  const hr = locale === "kk" ? "сағ" : locale === "ru" ? "ч" : "h";
  const m = Math.round(sec / 60);
  if (sec < 60) return ru ? `${Math.round(sec)} с` : `${Math.round(sec)} s`;
  if (m < 60) return ru ? `${m} мин` : `${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h} ${hr}${mm ? ` ${mm} ${ru ? "мин" : "min"}` : ""}`;
}

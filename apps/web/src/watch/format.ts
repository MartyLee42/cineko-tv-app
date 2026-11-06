// Pure helpers for watch progress display.
import type { ContinueItem, MediaProgress, WatchProgress } from "@martytv/contracts";
import { episodeCode } from "@martytv/media-types";

export { formatClock } from "../remote/logic";

/** Remaining time as "1 h 05 min" / "12 min" / "< 1 min"; null without a duration. */
export function formatLeft(
  p: Pick<WatchProgress, "position_seconds" | "duration_seconds">,
  locale: string,
): string | null {
  if (!p.duration_seconds) return null;
  const left = Math.max(0, p.duration_seconds - p.position_seconds);
  const min = Math.round(left / 60);
  const ru = locale.startsWith("ru");
  if (min < 1) return ru ? "< 1 мин" : "< 1 min";
  const h = Math.floor(min / 60);
  const m = min % 60;
  const unitH = ru ? "ч" : "h";
  const unitM = ru ? "мин" : "min";
  return h ? `${h} ${unitH} ${String(m).padStart(2, "0")} ${unitM}` : `${m} ${unitM}`;
}

export type ResumeState =
  | { kind: "start" }
  | { kind: "resume"; position: number; percent: number }
  | { kind: "again" };

/** Primary action for a movie/episode: start, resume at a position, or watch again. */
export function resumeState(p: WatchProgress | null | undefined): ResumeState {
  if (!p) return { kind: "start" };
  if (p.completed) return { kind: "again" };
  if (p.position_seconds >= 30) return { kind: "resume", position: p.position_seconds, percent: clamp01(p.percent) };
  return { kind: "start" };
}

export function clamp01(n: number | null | undefined): number {
  if (n == null || Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export interface SeasonProgress {
  done: number;
  total: number;
  /** 0..1 */
  ratio: number;
  complete: boolean;
}

export function seasonProgress(progress: MediaProgress | undefined, season: number): SeasonProgress | null {
  const s = progress?.seasons.find((x) => x.season_number === season);
  if (!s || s.total <= 0) return null;
  const done = Math.min(s.completed, s.total);
  return { done, total: s.total, ratio: done / s.total, complete: done >= s.total };
}

/** Episode progress keyed by episode id. */
export function episodeProgressMap(progress: MediaProgress | undefined): Map<string, WatchProgress> {
  const m = new Map<string, WatchProgress>();
  for (const e of progress?.episodes ?? []) if (e.episode_id) m.set(e.episode_id, e);
  return m;
}

/** Applies a manual watched toggle to cached progress (optimistic UI). */
export function applyWatchedLocally(
  progress: MediaProgress,
  change: { watched: boolean; episode_id?: string; season_number?: number },
  episodesOfSeason: { id: string; season_number: number; episode_number: number }[] = [],
  now = new Date().toISOString(),
): MediaProgress {
  const mark = (p: WatchProgress): WatchProgress => ({
    ...p,
    completed: change.watched,
    percent: change.watched ? 1 : 0,
    position_seconds: change.watched ? p.position_seconds : 0,
    completed_at: change.watched ? now : null,
    updated_at: now,
  });
  if (progress.kind === "movie") {
    const base: WatchProgress = progress.movie ?? blank(progress.media_id, null, null, null, now);
    return { ...progress, movie: mark(base) };
  }
  const targets =
    change.episode_id != null
      ? episodesOfSeason.filter((e) => e.id === change.episode_id)
      : change.season_number != null
        ? episodesOfSeason.filter((e) => e.season_number === change.season_number)
        : [];
  if (!targets.length) return progress;
  const byId = episodeProgressMap(progress);
  for (const e of targets) {
    byId.set(e.id, mark(byId.get(e.id) ?? blank(progress.media_id, e.id, e.season_number, e.episode_number, now)));
  }
  const episodes = [...byId.values()];
  const seasons = progress.seasons.map((s) => {
    const done = episodes.filter((e) => e.season_number === s.season_number && e.completed).length;
    return { ...s, completed: Math.min(s.total, done) };
  });
  return { ...progress, episodes, seasons };
}

function blank(media: string, ep: string | null, s: number | null, e: number | null, now: string): WatchProgress {
  return {
    media_id: media,
    episode_id: ep,
    season_number: s,
    episode_number: e,
    position_seconds: 0,
    duration_seconds: null,
    percent: 0,
    completed: false,
    completed_at: null,
    updated_at: now,
    device_id: null,
    source_id: null,
  };
}

/** What a continue-watching card shows and where tapping it leads. */
export function continueInfo(item: ContinueItem): {
  code: string | null;
  percent: number;
  /** Seconds to resume from (null = start of the next episode). */
  position: number | null;
  episodeId: string | null;
  href: string;
} {
  const p = item.progress;
  const inProgress = p && !p.completed ? p : null;
  const season = inProgress?.season_number ?? item.next_up?.season_number ?? null;
  const episode = inProgress?.episode_number ?? item.next_up?.episode_number ?? null;
  const code = season != null && episode != null ? episodeCode(season, episode) : null;
  const params = season != null && episode != null ? `?season=${season}&episode=${episode}` : "";
  return {
    code,
    percent: inProgress ? clamp01(inProgress.percent) : 0,
    position: inProgress && inProgress.position_seconds >= 30 ? inProgress.position_seconds : null,
    episodeId: inProgress?.episode_id ?? item.next_up?.episode_id ?? null,
    href: `/title/${item.media.id}${params}`,
  };
}

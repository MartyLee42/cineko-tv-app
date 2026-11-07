// Which episode comes next, and can the current release serve it? (pure)
import type { Release } from "@martytv/contracts";

export interface EpisodeLike {
  id: string;
  season_number: number;
  episode_number: number;
  name?: string;
  air_date?: string | null;
}

export interface EpisodeRef {
  season: number;
  episode: number;
  /** Known when the season's episode list was available. */
  id?: string;
  name?: string;
}

function aired(ep: EpisodeLike, today: string): boolean {
  return !ep.air_date || ep.air_date <= today;
}

/**
 * The episode after `cur`: the next aired one in the same season, else the
 * first aired one of the next regular season. Specials (season 0) never roll
 * over into regular seasons. Without the season's list, its episode_count
 * decides (unknown → null: never a guessed episode that may not exist).
 * `nextSeasonEpisodes` is the next season's list when known; without it the
 * next season's episode 1 is returned without id.
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
    if (after) return aired(after, today) ? toRef(after) : null;
  } else {
    // No episode list: the season's episode count says whether this one was its last.
    const count = seasons.find((s) => s.season_number === cur.season)?.episode_count;
    if (count === undefined) return null; // unknown: never offer a guessed episode
    if (cur.episode < count) return { season: cur.season, episode: cur.episode + 1 };
  }
  if (cur.season === 0) return null;
  const next = seasons
    .filter((s) => s.season_number > cur.season && (s.episode_count === undefined || s.episode_count > 0))
    .sort((a, b) => a.season_number - b.season_number)[0];
  if (!next) return null;
  if (next.air_date && next.air_date > today) return null;
  if (nextSeasonEpisodes) {
    const first = [...nextSeasonEpisodes].filter((e) => e.season_number === next.season_number).sort((a, b) => a.episode_number - b.episode_number)[0];
    if (!first || !aired(first, today)) return null;
    return toRef(first);
  }
  return { season: next.season_number, episode: 1 };
}

/**
 * The episode before `cur`: the previous one in the same season, else the
 * last episode of the previous regular season (its list when known, else its
 * episode_count). Specials (season 0) never roll back into regular seasons.
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
    if (before) return toRef(before);
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
    return last ? toRef(last) : null;
  }
  return prev.episode_count ? { season: prev.season_number, episode: prev.episode_count } : null;
}

function toRef(e: EpisodeLike): EpisodeRef {
  const ref: EpisodeRef = { season: e.season_number, episode: e.episode_number, id: e.id };
  if (e.name) ref.name = e.name;
  return ref;
}

/** Whether a (season pack) release can serve an episode without a new search. */
export function packCovers(r: Pick<Release, "is_season_pack" | "seasons" | "episodes">, season: number, episode: number): boolean {
  if (!r.is_season_pack) return false;
  if (r.seasons.length > 0 && !r.seasons.includes(season)) return false;
  if (r.episodes.length > 0 && !r.episodes.includes(episode)) return false;
  return true;
}

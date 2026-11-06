// Season selection on a series' Details.

interface SeasonLike {
  season_number: number;
}

/** Season shown first: season 1 (or the first regular one), not specials. */
export function defaultSeason(seasons: readonly SeasonLike[]): number | null {
  return (seasons.find((s) => s.season_number >= 1) ?? seasons[0])?.season_number ?? null;
}

/**
 * The season to show: the chosen/requested one if the series has it, else
 * the default. Before the seasons are known the request is trusted.
 */
export function pickSeason(seasons: readonly SeasonLike[] | undefined, wanted: number | null | undefined): number | null {
  if (!seasons) return wanted ?? null;
  if (wanted !== null && wanted !== undefined && seasons.some((s) => s.season_number === wanted)) return wanted;
  return defaultSeason(seasons);
}

/** Index of an episode number in a season's list (0 when absent). */
export function episodeIndex(episodes: readonly { episode_number: number }[], episode: number | undefined): number {
  if (episode === undefined) return 0;
  return Math.max(0, episodes.findIndex((e) => e.episode_number === episode));
}

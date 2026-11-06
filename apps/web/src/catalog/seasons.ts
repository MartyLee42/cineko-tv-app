import type { Schemas } from "@martytv/contracts";

type SeasonSummary = Schemas["SeasonSummary"];

/** Regular seasons ascending, specials (season 0) last. */
export function orderSeasons<T extends Pick<SeasonSummary, "season_number">>(seasons: readonly T[]): T[] {
  return [...seasons].sort((a, b) => {
    if (a.season_number === 0) return 1;
    if (b.season_number === 0) return -1;
    return a.season_number - b.season_number;
  });
}

/**
 * The season to show first: the latest regular season that has already aired,
 * else season 1, else the first season listed (possibly specials). Null when
 * there are no seasons at all.
 */
export function defaultSeason(
  seasons: readonly Pick<SeasonSummary, "season_number" | "air_date" | "episode_count">[],
  today: string = new Date().toISOString().slice(0, 10),
): number | null {
  const regular = seasons.filter((s) => s.season_number > 0);
  const aired = regular
    .filter((s) => s.air_date != null && s.air_date <= today && s.episode_count > 0)
    .sort((a, b) => b.season_number - a.season_number);
  if (aired[0]) return aired[0].season_number;
  if (regular.some((s) => s.season_number === 1)) return 1;
  const ordered = orderSeasons(seasons);
  return ordered[0]?.season_number ?? null;
}

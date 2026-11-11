// The episode the built-in player last left a series at, so a Details page
// it was started from shows that one on return — not the season / episode
// it remembered from before the player moved on (next episode across a
// season boundary: S1E10 → S2E1 used to come back to season 1, E10 focused).
// The progress the page has cached is from before playback too: it refetches,
// but the season and the focused card were already decided from it.

export interface PlayedRef {
  season: number;
  episode: number;
  /** Unknown when the next season's list wasn't loaded. */
  episode_id: string | null;
  /** When playback left it (ms). */
  at: number;
}

const last = new Map<string, PlayedRef>();

/** The player left `mediaId` at this episode (the next one when it was finished). */
export function notePlayed(mediaId: string, ref: PlayedRef) {
  last.set(mediaId, ref);
}

export function lastPlayed(mediaId: string): PlayedRef | null {
  return last.get(mediaId) ?? null;
}

/** For tests. */
export function clearPlayed() {
  last.clear();
}

interface Memory {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

/**
 * Called as a series' Details (re)mounts. When the player left the title at
 * an episode after this page was last shown, the page's memory follows it:
 * that season, no remembered card index in it (the played one is focused),
 * and a remembered episode-card focus moves to it. A page shown for the first
 * time is left alone (the server's fresh next-up decides). Returns the
 * episode to focus, if any.
 */
export function adoptPlayed(mem: Memory, played: PlayedRef | null, now: number): PlayedRef | null {
  const shownAt = mem.get<number>("shownAt");
  mem.set("shownAt", now);
  const prev = mem.get<PlayedRef>("played") ?? null;
  if (shownAt === undefined || !played || played.at < shownAt) return prev;
  mem.set("season", played.season);
  mem.set(`idx-ep-${played.season}`, undefined);
  mem.set("played", played);
  const fk = mem.get<string>("focusKey");
  if (fk?.startsWith("ep-")) mem.set("focusKey", played.episode_id ? `ep-${played.episode_id}` : "d-episodes");
  return played;
}

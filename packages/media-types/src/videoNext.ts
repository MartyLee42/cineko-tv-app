// «Видео»: what plays when a YouTube video ends (profile setting
// video_autoplay, on by default). A video that is part of a series («Часть 3»,
// «Серия 3», "Episode 3", "#3", "S01E03"…) continues with the next part from
// the same channel; anything else continues with a random related video.

export interface NextVideoCandidate {
  id: string;
  title: string;
  channel_id: string;
  live: boolean;
  upcoming: boolean;
  short?: boolean;
  /** With a profile: how far it was watched. */
  progress?: { position_seconds: number; duration_seconds: number; finished: boolean } | null;
}

export interface SeriesPart {
  /** The title with the part number taken out, normalised (lower case, single spaces). */
  stem: string;
  n: number;
}

// Word + number: «часть 3», «серия 03», "episode 3", "ep. 3", "part 3", «выпуск 12», "#3".
const WORD_NUM = /(?:^|[\s([|:,.–—-])(часть|ч\.|серия|сер\.|эпизод|выпуск|глава|урок|день|part|pt\.?|episode|ep\.?|chapter|lesson|day|vol\.?|#)\s*(\d{1,4})(?=$|[\s)\]|:,.!?–—-])/iu;
// Number + word: «3 серия», «3-я часть», «12 выпуск».
const NUM_WORD = /(?:^|[\s([|:,.–—-])(\d{1,4})(?:\s*-?\s*(?:я|й|ая|ий))?\s+(часть|серия|выпуск|эпизод|глава|урок|день)(?=$|[\s)\]|:,.!?–—-])/iu;
// S01E03 / 1x03: the episode counts (season stays in the stem).
const SXE = /\b(s\d{1,2}\s*e|\d{1,2}x)(\d{1,3})\b/iu;

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[«»"“”'’|()[\]:,.!?–—-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The part number of a series video, or null for a standalone one. */
export function seriesPart(title: string): SeriesPart | null {
  let m = SXE.exec(title);
  if (m) return { stem: norm(title.slice(0, m.index) + m[1]!.replace(/\s+/g, "") + "#" + title.slice(m.index + m[0].length)), n: Number(m[2]) };
  m = WORD_NUM.exec(title);
  if (m) {
    const at = m.index + m[0].length - m[2]!.length;
    return { stem: norm(title.slice(0, at) + "#" + title.slice(at + m[2]!.length)), n: Number(m[2]) };
  }
  m = NUM_WORD.exec(title);
  if (m) {
    const at = m.index + m[0].indexOf(m[1]!);
    return { stem: norm(title.slice(0, at) + "#" + title.slice(at + m[1]!.length)), n: Number(m[1]) };
  }
  return null;
}

/** Playable as the next video (not live / upcoming, not a Short, not this one). */
function playable(v: NextVideoCandidate, currentId: string): boolean {
  return v.id !== currentId && !v.live && !v.upcoming && !v.short;
}

/**
 * The next part of `current`'s series among `candidates`: same channel,
 * same title around the number, number + 1 (else the smallest number above,
 * a skipped part).
 */
export function nextInSeries<T extends NextVideoCandidate>(current: Pick<NextVideoCandidate, "id" | "title" | "channel_id">, candidates: readonly T[]): T | null {
  const cur = seriesPart(current.title);
  if (!cur) return null;
  let best: T | null = null;
  let bestN = Infinity;
  for (const v of candidates) {
    if (!playable(v, current.id) || v.channel_id !== current.channel_id) continue;
    const p = seriesPart(v.title);
    if (!p || p.stem !== cur.stem || p.n <= cur.n || p.n >= bestN) continue;
    best = v;
    bestN = p.n;
  }
  return best;
}

const watched = (v: NextVideoCandidate) => {
  const p = v.progress;
  if (!p) return false;
  if (p.finished) return true;
  return p.duration_seconds > 0 && p.position_seconds / p.duration_seconds > 0.9;
};

/**
 * What plays next: the series' next part (from `related`, then the channel's
 * own `channel` list), else a random related video — preferring ones this
 * profile hasn't watched and skipping `recent` (played in this session).
 */
export function pickNextVideo<T extends NextVideoCandidate>(
  current: Pick<NextVideoCandidate, "id" | "title" | "channel_id">,
  related: readonly T[],
  channel: readonly T[] = [],
  opts: { random?: () => number; recent?: ReadonlySet<string> } = {},
): { video: T; why: "series" | "random" } | null {
  const series = nextInSeries(current, related) ?? nextInSeries(current, channel);
  if (series) return { video: series, why: "series" };
  const recent = opts.recent ?? new Set<string>();
  const pool = related.filter((v) => playable(v, current.id) && !recent.has(v.id));
  const fresh = pool.filter((v) => !watched(v));
  const from = fresh.length ? fresh : pool;
  if (!from.length) return null;
  const r = opts.random ?? Math.random;
  return { video: from[Math.min(from.length - 1, Math.floor(r() * from.length))]!, why: "random" };
}

/** A series video whose next part may be on the channel's list (worth fetching it). */
export function looksLikeSeries(title: string): boolean {
  return seriesPart(title) !== null;
}

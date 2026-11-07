// «Под фильм»: the loading animation that suits the title, from what the
// player already knows when a load starts (TMDB genres, kind, language and
// the title / overview text — no extra requests). Pure; loaderMatch.test.ts.
import type { LoaderAnimation } from "./loaderSurprise";

export interface MatchInfo {
  /** The media id: titles nothing matches get a stable pick from it. */
  id: string;
  kind?: string | null;
  /** TMDB genre ids (movie and TV ids). */
  genre_ids?: readonly number[];
  original_language?: string | null;
  /** Title, original title, tagline, overview (any language). */
  text?: string;
  /** TMDB keyword names, when the client has them. */
  keywords?: readonly string[];
}

/** What a MediaDetail / summary gives (all optional: a cache miss still answers). */
export function matchInfoOf(
  id: string,
  m?: {
    kind?: string | null;
    genres?: readonly { id: number }[] | null;
    genre_ids?: readonly number[] | null;
    original_language?: string | null;
    title?: string | null;
    original_title?: string | null;
    tagline?: string | null;
    overview?: string | null;
  } | null,
): MatchInfo {
  if (!m) return { id };
  const genres = m.genres?.map((g) => g.id) ?? m.genre_ids ?? [];
  return {
    id,
    kind: m.kind ?? null,
    genre_ids: genres,
    original_language: m.original_language ?? null,
    text: [m.title, m.original_title, m.tagline, m.overview].filter(Boolean).join(" \n "),
  };
}

// TMDB genre ids (movie / TV).
const G = {
  animation: 16,
  family: 10751,
  kids: 10762,
  comedy: 35,
  horror: 27,
  thriller: 53,
  mystery: 9648,
  documentary: 99,
  drama: 18,
  history: 36,
  scifi: 878,
  scifiFantasyTv: 10765,
};

/** Word stems per theme (lower-case, matched inside words: «космическ» finds «космического»). */
const THEMES: [LoaderAnimation, RegExp][] = [
  ["matrix", /(hacker|cyber|virtual reality|simulation|artificial intelligence|хакер|кибер|виртуальн|симуляц|искусственн\w* интеллект)/],
  ["speed88", /(time travel|time machine|time loop|back in time|путешеств\w* во времени|машин\w* времени|временн\w* петл|в прошлое)/],
  ["odyssey", /(\b(outer )?space\b|astronaut|\baliens?\b|spacecraft|spaceship|\bplanets?\b|galaxy|космос|космическ|космонавт|астронавт|инопланет|планет|галактик|звездолёт|звездолет)/],
  ["paws", /(\bcats?\b|kitten|\bdogs?\b|pupp|animal|(^|[^а-яё])(кот|кота|коты|котик|котов|коту|котом)(?![а-яё])|кошк|котён|котен|собак|щен|животн)/],
];

/** Generic styles a title without a theme gets one of (stable per id). */
export const MATCH_GENERIC: readonly LoaderAnimation[] = ["popcorn", "fill_title", "poster_reveal", "film_reel", "marty", "paws", "aquarium", "balloons"];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A stable choice from `list` for this title. */
function stable(id: string, list: readonly LoaderAnimation[]): LoaderAnimation {
  return list[hash(id) % list.length]!;
}

/**
 * The loader for a title: themes found in its keywords / text first
 * (hacker → matrix, time travel → 88 mph, space → odyssey, cats → paws),
 * then genres (animation / family → balloons or aquarium, horror / thriller
 * → minimal, sci-fi → odyssey, comedy → popcorn, documentary / drama /
 * history → film reel or poster reveal), else a stable pick per title.
 */
export function matchLoader(info: MatchInfo | null | undefined): LoaderAnimation {
  if (!info) return "popcorn";
  const words = [...(info.keywords ?? []), info.text ?? ""].join(" \n ").toLowerCase();
  for (const [style, re] of THEMES) if (re.test(words)) return style;
  const g = new Set(info.genre_ids ?? []);
  if (g.has(G.animation) || g.has(G.family) || g.has(G.kids)) return stable(info.id, ["balloons", "aquarium"]);
  if (g.has(G.horror) || g.has(G.thriller) || g.has(G.mystery)) return "minimal";
  if (g.has(G.scifi) || g.has(G.scifiFantasyTv)) return "odyssey";
  if (g.has(G.comedy)) return "popcorn";
  if (g.has(G.documentary) || g.has(G.drama) || g.has(G.history)) return stable(info.id, ["film_reel", "poster_reveal"]);
  return stable(info.id, MATCH_GENERIC);
}

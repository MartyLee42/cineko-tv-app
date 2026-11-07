// «Тема под фильм»: which look a title's Details page and loading screen take
// (when the profile's film_theme is on). Pure: from MediaDetail's year,
// genres, countries, original language and runtime. The clients keep each
// theme's CSS in a lazy chunk and only grade colours, swap the title font
// and lay a static grain/vignette — the menu keeps the profile's design.

export const FILM_THEMES = ["silent", "classic", "noir", "soviet_toon", "soviet", "anime", "western", "horror", "eighties", "scifi"] as const;
export type FilmTheme = (typeof FILM_THEMES)[number];

/** The bits of MediaDetail (or MediaSummary) the classifier reads. */
export interface FilmThemeInput {
  year?: number | null;
  release_date?: string | null;
  genres?: readonly { id: number }[];
  genre_ids?: readonly number[];
  original_language?: string | null;
  countries?: readonly string[] | null;
  runtime?: number | null;
}

/** TMDB genre ids (movie and TV lists). */
const G = { animation: 16, crime: 80, thriller: 53, mystery: 9648, western: 37, horror: 27, scifi: 878, scifiTv: 10765 };

function yearOf(d: FilmThemeInput): number | null {
  if (d.year) return d.year;
  const y = d.release_date ? Number(d.release_date.slice(0, 4)) : NaN;
  return Number.isFinite(y) && y > 1800 ? y : null;
}

/** The title's film theme, or null (no theme: the design as is). */
export function filmTheme(d: FilmThemeInput | null | undefined): FilmTheme | null {
  if (!d) return null;
  const year = yearOf(d);
  const ids = new Set<number>([...(d.genres ?? []).map((g) => g.id), ...(d.genre_ids ?? [])]);
  const has = (...gs: number[]) => gs.some((g) => ids.has(g));
  const countries = d.countries ?? [];
  const lang = (d.original_language ?? "").toLowerCase();
  const old = year !== null && year < 1992;
  // The USSR: TMDB marks most Soviet titles «SU»; older Russian-language ones count too.
  const soviet = countries.includes("SU") || (old && (countries.includes("RU") || (lang === "ru" && countries.length === 0)));
  const animation = has(G.animation);
  const shortFilm = !!d.runtime && d.runtime <= 40;

  if (year !== null && year <= 1929) return "silent";
  if (animation && (soviet || (old && lang === "ru" && shortFilm))) return "soviet_toon";
  if (animation && (countries.includes("JP") || lang === "ja")) return "anime";
  if (year !== null && year <= 1960 && has(G.crime, G.thriller, G.mystery) && !soviet) return "noir";
  if (year !== null && year <= 1959 && !soviet) return "classic";
  if (soviet && old) return "soviet";
  if (has(G.western)) return "western";
  if (has(G.horror)) return "horror";
  if (year !== null && year >= 1980 && year <= 1989) return "eighties";
  if (has(G.scifi, G.scifiTv)) return "scifi";
  return null;
}

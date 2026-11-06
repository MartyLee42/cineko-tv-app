// Home rows and "see all" lists, shared by the web and TV builds.
import type { MsgKey } from "../core/i18n";
import { listPage, type MediaType, type Paged, type TmdbItem } from "../core/tmdb";

export interface RowDef {
  id: string;
  label: MsgKey;
  path: string;
  params?: Record<string, string | number>;
  type?: MediaType;
}

export const ROWS: RowDef[] = [
  { id: "trending", label: "trending", path: "/trending/all/week" },
  { id: "popular-movie", label: "popularMovies", path: "/movie/popular", type: "movie" },
  { id: "popular-tv", label: "popularTv", path: "/tv/popular", type: "tv" },
  { id: "now-playing", label: "nowPlaying", path: "/movie/now_playing", type: "movie" },
  { id: "top-movie", label: "topMovies", path: "/movie/top_rated", type: "movie" },
  { id: "top-tv", label: "topTv", path: "/tv/top_rated", type: "tv" },
  { id: "g-action", label: "genreAction", path: "/discover/movie", params: { with_genres: 28, sort_by: "popularity.desc", "vote_count.gte": 300 }, type: "movie" },
  { id: "g-comedy", label: "genreComedy", path: "/discover/movie", params: { with_genres: 35, sort_by: "popularity.desc", "vote_count.gte": 300 }, type: "movie" },
  { id: "g-scifi", label: "genreScifi", path: "/discover/movie", params: { with_genres: 878, sort_by: "popularity.desc", "vote_count.gte": 300 }, type: "movie" },
  { id: "g-animation", label: "genreAnimation", path: "/discover/movie", params: { with_genres: 16, sort_by: "popularity.desc", "vote_count.gte": 200 }, type: "movie" },
  { id: "g-crime", label: "genreCrime", path: "/discover/tv", params: { with_genres: 80, sort_by: "popularity.desc", "vote_count.gte": 200 }, type: "tv" },
  { id: "g-horror", label: "genreHorror", path: "/discover/movie", params: { with_genres: 27, sort_by: "popularity.desc", "vote_count.gte": 300 }, type: "movie" },
  { id: "g-drama", label: "genreDrama", path: "/discover/movie", params: { with_genres: 18, sort_by: "popularity.desc", "vote_count.gte": 500 }, type: "movie" },
];

export function rowById(id: string): RowDef | undefined {
  return ROWS.find((r) => r.id === id);
}

export function loadRow(r: RowDef, page = 1): Promise<Paged<TmdbItem>> {
  return listPage(r.path, r.params ?? {}, r.type, page);
}

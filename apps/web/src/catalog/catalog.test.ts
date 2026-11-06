import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  browseToParams,
  EMPTY_FILTERS,
  listTitleKey,
  parseBrowse,
  toDiscoverQuery,
  type BrowseState,
} from "./filters";
import { defaultSeason, orderSeasons } from "./seasons";

const parse = (qs: string) => parseBrowse(new URLSearchParams(qs));

describe("browse URL state", () => {
  it("defaults to movies sorted by popularity", () => {
    expect(parse("")).toEqual({ mode: "discover", kind: "movie", ...EMPTY_FILTERS });
  });

  it("round-trips every filter", () => {
    const state: BrowseState = {
      mode: "discover",
      kind: "movie",
      genres: [18, 28],
      yearFrom: 1990,
      yearTo: 1999,
      runtime: "medium",
      language: "ko",
      ratingMin: 7,
      sort: "rating",
    };
    const qs = browseToParams(state).toString();
    expect(qs).toBe("kind=movie&genres=18%2C28&year_from=1990&year_to=1999&runtime=medium&lang=ko&rating=7&sort=rating");
    expect(parse(qs)).toEqual(state);
  });

  it("omits defaults from the query string", () => {
    expect(browseToParams({ mode: "discover", kind: "series", ...EMPTY_FILTERS }).toString()).toBe("kind=series");
  });

  it("ignores malformed values and dedupes genres", () => {
    const s = parse("kind=tv&genres=28,x,28,12&year_from=abc&runtime=huge&lang=xx&rating=11&sort=bogus");
    expect(s).toEqual({ mode: "discover", kind: "movie", ...EMPTY_FILTERS, genres: [12, 28] });
  });

  it("drops the runtime filter for series", () => {
    expect(parse("kind=series&runtime=short")).toMatchObject({ runtime: null });
  });

  it("parses curated lists with their default kind", () => {
    expect(parse("list=top_rated&kind=series")).toEqual({ mode: "list", list: "top_rated", kind: "series" });
    expect(parse("list=trending")).toEqual({ mode: "list", list: "trending", kind: "all" });
    expect(parse("list=on_the_air")).toEqual({ mode: "list", list: "on_the_air", kind: "series" });
    expect(parse("list=nope&kind=series")).toMatchObject({ mode: "discover", kind: "series" });
    expect(browseToParams({ mode: "list", list: "upcoming", kind: "movie" }).toString()).toBe("list=upcoming&kind=movie");
  });
});

describe("discover query", () => {
  it("maps runtime buckets and swaps an inverted year range", () => {
    expect(
      toDiscoverQuery({ kind: "movie", ...EMPTY_FILTERS, runtime: "short", yearFrom: 2010, yearTo: 2000, genres: [35] }),
    ).toEqual({ kind: "movie", sort: "popularity", genres: "35", year_from: 2000, year_to: 2010, runtime_max: 89 });
    expect(toDiscoverQuery({ kind: "movie", ...EMPTY_FILTERS, runtime: "long" })).toMatchObject({ runtime_min: 151 });
  });

  it("never sends runtime for series", () => {
    const q = toDiscoverQuery({ kind: "series", ...EMPTY_FILTERS, runtime: "medium", language: "ru", ratingMin: 6 });
    expect(q).toEqual({ kind: "series", sort: "popularity", original_language: "ru", rating_min: 6 });
  });

  it("counts active filters", () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...EMPTY_FILTERS, genres: [1, 2], yearTo: 2000, sort: "title" })).toBe(2);
  });

  it("knows home row titles", () => {
    expect(listTitleKey("top_rated", "series")).toBe("catalog.row.top_rated_series");
    expect(listTitleKey("now_playing", "movie")).toBeNull();
  });
});

describe("seasons", () => {
  const s = (season_number: number, air_date: string | null, episode_count = 10) => ({
    season_number,
    air_date,
    episode_count,
  });

  it("orders specials last", () => {
    expect(orderSeasons([s(0, null), s(2, null), s(1, null)]).map((x) => x.season_number)).toEqual([1, 2, 0]);
  });

  it("picks the latest aired season", () => {
    expect(defaultSeason([s(0, "2000-01-01"), s(1, "2020-01-01"), s(2, "2022-01-01"), s(3, "2099-01-01")], "2024-06-01")).toBe(2);
  });

  it("falls back to season 1, then the first listed, then null", () => {
    expect(defaultSeason([s(1, null), s(2, "2099-01-01")], "2024-06-01")).toBe(1);
    expect(defaultSeason([s(1, "2020-01-01", 0)], "2024-06-01")).toBe(1);
    expect(defaultSeason([s(0, "2020-01-01")], "2024-06-01")).toBe(0);
    expect(defaultSeason([], "2024-06-01")).toBeNull();
  });
});

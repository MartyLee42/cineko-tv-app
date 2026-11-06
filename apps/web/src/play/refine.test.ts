import { describe, expect, it } from "vitest";
import {
  cleanQuery,
  defaultQuery,
  isRefined,
  NO_REFINE,
  queryChips,
  rememberedRefine,
  rememberRefine,
  validQuery,
  withoutYear,
  withSeason,
  withYear,
  type RefineTitle,
} from "./refine";
import { releaseParams } from "./releases";
import { releasesKey } from "./queries";

const movie: RefineTitle = { title: "Начало", original_title: "Inception", year: 2010, kind: "movie" };
const series: RefineTitle = { title: "Разделение", original_title: "Severance", year: 2022, kind: "series", season_number: 2 };

describe("refine query pre-fill", () => {
  it("pre-fills the Russian title and year", () => {
    expect(defaultQuery(movie)).toBe("Начало 2010");
    expect(defaultQuery({ ...movie, year: null })).toBe("Начало");
  });

  it("cleans and validates", () => {
    expect(cleanQuery("  Начало   2010 ")).toBe("Начало 2010");
    expect(cleanQuery("x".repeat(150))).toHaveLength(100);
    expect(validQuery("a")).toBe(false);
    expect(validQuery(" ab ")).toBe(true);
  });

  it("adds and removes the year and season", () => {
    expect(withoutYear("Начало 2010", 2010)).toBe("Начало");
    expect(withoutYear("Начало (2010) BDRip", 2010)).toBe("Начало BDRip");
    expect(withoutYear("2010 Начало", 2010)).toBe("Начало");
    expect(withYear("Начало", 2010)).toBe("Начало 2010");
    expect(withYear("Начало 2010", 2010)).toBe("Начало 2010");
    expect(withSeason("Разделение", 2)).toBe("Разделение S02");
    expect(withSeason("Разделение S01", 2)).toBe("Разделение S02");
  });

  it("offers chips that change something", () => {
    expect(queryChips(movie, "Начало 2010")).toEqual([
      { key: "original", query: "Inception 2010" },
      { key: "no_year", query: "Начало" },
    ]);
    // On the original title: back to Russian; without the year: add it.
    expect(queryChips(movie, "Inception")).toEqual([
      { key: "local", query: "Начало" },
      { key: "year", query: "Inception 2010" },
    ]);
    expect(queryChips(series, "Разделение 2022").map((c) => c.key)).toEqual(["original", "no_year", "season"]);
    expect(queryChips(series, "Разделение S02").find((c) => c.key === "original")?.query).toBe("Severance S02");
    // Same original title: no switch chip.
    expect(queryChips({ ...movie, original_title: "Начало" }, "Начало 2010").map((c) => c.key)).toEqual(["no_year"]);
  });
});

describe("refine memory and request", () => {
  it("remembers the last refine per title in this tab", () => {
    expect(rememberedRefine("m1")).toEqual(NO_REFINE);
    rememberRefine("m1", { q: "  Начало  ", loose: true });
    expect(rememberedRefine("m1")).toEqual({ q: "Начало", loose: true });
    expect(isRefined(rememberedRefine("m1"))).toBe(true);
    rememberRefine("m1", NO_REFINE);
    expect(rememberedRefine("m1")).toEqual(NO_REFINE);
  });

  it("sends q / loose and caches refined lists separately", () => {
    expect(releaseParams({ media_id: "m" }, { q: "Начало", loose: true })).toEqual({ q: "Начало", loose: true });
    expect(releaseParams({ media_id: "m" }, { q: null, loose: false })).toEqual({});
    expect(releasesKey({ media_id: "m" }, "p", "ru")).toHaveLength(6);
    expect(releasesKey({ media_id: "m" }, "p", "ru", { q: "x", loose: false }).at(-1)).toEqual({ q: "x", loose: false });
  });
});

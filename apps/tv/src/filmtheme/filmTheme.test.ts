import { describe, expect, it } from "vitest";
import { filmTheme, type FilmThemeInput } from "@martytv/media-types";

const g = (...ids: number[]) => ids.map((id) => ({ id }));
const t = (d: FilmThemeInput | null) => filmTheme(d);

describe("filmTheme", () => {
  it("silent era first, whatever the genre", () => {
    expect(t({ year: 1927, genres: g(878) })).toBe("silent");
    expect(t({ release_date: "1925-12-21", genres: [] })).toBe("silent");
    expect(t({ year: 1929, genres: g(16), countries: ["SU"] })).toBe("silent");
  });

  it("Soviet animation (SU, or an old Russian-language short), but not today's", () => {
    expect(t({ year: 1969, genres: g(16, 10751), countries: ["SU"], original_language: "ru" })).toBe("soviet_toon");
    expect(t({ year: 1975, genres: g(16), countries: [], original_language: "ru", runtime: 10 })).toBe("soviet_toon");
    expect(t({ year: 1985, genres: g(16), countries: ["RU"] })).toBe("soviet_toon");
    expect(t({ year: 2015, genres: g(16), countries: ["RU"], original_language: "ru" })).toBeNull();
  });

  it("anime: animation from Japan", () => {
    expect(t({ year: 2001, genres: g(16, 14), countries: ["JP"], original_language: "ja" })).toBe("anime");
    expect(t({ year: 1988, genres: g(16), original_language: "ja" })).toBe("anime");
    expect(t({ year: 2001, genres: g(16), countries: ["US"], original_language: "en" })).toBeNull();
  });

  it("noir: old crime / thriller / mystery; otherwise classic b&w years", () => {
    expect(t({ year: 1944, genres: g(80, 18), countries: ["US"] })).toBe("noir");
    expect(t({ year: 1958, genres: g(53) })).toBe("noir");
    expect(t({ year: 1960, genres: g(9648) })).toBe("noir");
    expect(t({ year: 1939, genres: g(18, 10749), countries: ["US"] })).toBe("classic");
    expect(t({ year: 1961, genres: g(80) })).toBeNull();
  });

  it("Soviet cinema: the film-studio look (also for old Soviet crime)", () => {
    expect(t({ year: 1957, genres: g(18, 10752), countries: ["SU"] })).toBe("soviet");
    expect(t({ year: 1979, genres: g(80), countries: ["SU"] })).toBe("soviet");
    expect(t({ year: 1972, genres: g(878), countries: ["SU"] })).toBe("soviet");
    expect(t({ year: 1990, genres: g(35), countries: ["RU"] })).toBe("soviet");
    expect(t({ year: 1995, genres: g(35), countries: ["RU"] })).toBeNull();
  });

  it("genres: western, horror, then the 80s, then sci-fi", () => {
    expect(t({ year: 1966, genres: g(37) })).toBe("western");
    expect(t({ year: 1984, genres: g(37) })).toBe("western");
    expect(t({ year: 1978, genres: g(27) })).toBe("horror");
    expect(t({ year: 1985, genres: g(878, 12) })).toBe("eighties");
    expect(t({ year: 1986, genres: g(35) })).toBe("eighties");
    expect(t({ year: 2014, genres: g(878, 18) })).toBe("scifi");
    expect(t({ year: 2016, genre_ids: [10765] })).toBe("scifi");
  });

  it("nothing special: no theme", () => {
    expect(t({ year: 2019, genres: g(18, 35), countries: ["FR"] })).toBeNull();
    expect(t({})).toBeNull();
    expect(t(null)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { fillBlanks, onlyTitles, typeOf } from "./tmdb";

describe("Kazakh fallback (fillBlanks)", () => {
  it("fills empty overviews and untranslated titles from Russian", () => {
    const kk = { id: 603, title: "The Matrix", original_title: "The Matrix", overview: "", genres: [{ id: 28, name: "Action" }], tagline: "" };
    const ru = { id: 603, title: "Матрица", original_title: "The Matrix", overview: "Жизнь Томаса…", genres: [{ id: 28, name: "боевик" }], tagline: "Добро пожаловать" };
    expect(fillBlanks(kk, ru)).toEqual({ ...ru });
  });
  it("keeps real Kazakh texts and matches list items by id", () => {
    const kk = { results: [{ id: 2, name: "Достар", original_name: "Friends", overview: "" }, { id: 1, title: "X", original_title: "X", overview: "қаз" }] };
    const ru = { results: [{ id: 1, title: "Икс", original_title: "X", overview: "рус" }, { id: 2, name: "Друзья", original_name: "Friends", overview: "о друзьях" }] };
    expect(fillBlanks(kk, ru)).toEqual({
      results: [
        { id: 2, name: "Достар", original_name: "Friends", overview: "о друзьях" },
        { id: 1, title: "Икс", original_title: "X", overview: "қаз" },
      ],
    });
  });
  it("matches episodes by number", () => {
    const kk = { episodes: [{ episode_number: 1, name: "Epızod 1", overview: "" }] };
    const ru = { episodes: [{ episode_number: 1, name: "Эпизод 1", overview: "Начало" }] };
    expect(fillBlanks(kk, ru)).toEqual({ episodes: [{ episode_number: 1, name: "Epızod 1", overview: "Начало" }] });
  });
});

describe("types", () => {
  it("tells movies from series", () => {
    expect(typeOf({ id: 1, media_type: "tv" })).toBe("tv");
    expect(typeOf({ id: 1, name: "x", first_air_date: "2000" })).toBe("tv");
    expect(typeOf({ id: 1, title: "x" })).toBe("movie");
    expect(onlyTitles([{ id: 1, media_type: "person" }, { id: 2, title: "a" }], "movie")).toEqual([{ id: 2, title: "a", media_type: "movie" }]);
  });
});

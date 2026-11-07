import { describe, expect, it } from "vitest";
import { likedThemes, themeAffinities, type ThemeLike } from "./logic";

const th = (id: number, name: string, score: number, localized = true): ThemeLike => ({ id, name, localized, score, count: 3 });

describe("taste themes", () => {
  it("headlines the liked themes that have a name in the UI language", () => {
    const items = [th(1, "ограбления", 1), th(2, "heist-like", 0.9, false), th(3, "временную петлю", 0.5), th(4, "маленький городок", 0.2), th(5, "зомби", -0.8)];
    expect(likedThemes(items)).toEqual({ text: "ограбления, временную петлю", localized: true });
    expect(likedThemes(items, 1)).toEqual({ text: "ограбления", localized: true });
  });

  it("falls back to the best untranslated one, or nothing", () => {
    expect(likedThemes([th(1, "slow burn", 0.7, false), th(2, "heist", 0.9, false)])).toEqual({ text: "heist", localized: false });
    expect(likedThemes([th(1, "zombie", -0.5)])).toBeNull();
  });

  it("maps themes onto affinity bars", () => {
    expect(themeAffinities([th(10051, "ограбления", 1)])).toEqual([{ key: "10051", name: "ограбления", score: 1, count: 3 }]);
  });
});

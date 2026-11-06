import { describe, expect, it } from "vitest";
import { isUncertain, refineDefault, refineValid, stripYear, withSeason } from "./refine";

describe("refine", () => {
  it("pre-fills title and year", () => {
    expect(refineDefault(" Дюна: Часть вторая ", 2024)).toBe("Дюна: Часть вторая 2024");
    expect(refineDefault("Dune", null)).toBe("Dune");
  });
  it("strips the year only when standalone", () => {
    expect(stripYear("Дюна 2024")).toBe("Дюна");
    expect(stripYear("Blade Runner 2049 1982")).toBe("Blade Runner 2049");
    expect(stripYear("1917 2019")).toBe("1917");
    expect(stripYear("1917")).toBe("1917");
    expect(stripYear("Area51")).toBe("Area51");
  });
  it("adds or replaces the season tag", () => {
    expect(withSeason("Сёгун 2024", 1)).toBe("Сёгун 2024 S01");
    expect(withSeason("Shogun S02E03", 1)).toBe("Shogun S01");
    expect(withSeason("Show", 12)).toBe("Show S12");
  });
  it("validates and flags uncertain matches", () => {
    expect(refineValid("a")).toBe(false);
    expect(refineValid(" ab ")).toBe(true);
    expect(refineValid("x".repeat(101))).toBe(false);
    expect(isUncertain({ warnings: ["uncertain_match"] })).toBe(true);
    expect(isUncertain({ warnings: [] })).toBe(false);
  });
});

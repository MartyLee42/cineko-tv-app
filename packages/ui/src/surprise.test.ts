import { describe, expect, it } from "vitest";
import { DESIGNS, type DesignSetting } from "./designs";
import { effectiveDesign, localDayIndex, nextSurpriseBoundary, surpriseCandidates, surprisePeriod, surprisePick } from "./surprise";

const P = "3f0c9a2e-1111-4222-8333-444455556666";
// Local dates (the device's own timezone, whatever the test runner's is).
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);

describe("design surprise", () => {
  it("is off unless asked, and keeps the chosen design", () => {
    expect(effectiveDesign({ design: "deco" }, P, at(2026, 11, 7))).toBe("deco");
    expect(effectiveDesign({ design: "deco", design_surprise: "off", design_favorites: ["matrix", "popart"] }, P, at(2026, 11, 7))).toBe("deco");
    expect(effectiveDesign({ design: "deco", design_surprise: "hourly" }, P, at(2026, 11, 7))).toBe("deco");
  });

  it("falls back to the chosen design with a single favourite; empty favourites = every design", () => {
    for (let d = 1; d <= 20; d++) {
      expect(effectiveDesign({ design: "deco", design_surprise: "day", design_favorites: ["matrix"] }, P, at(2026, 11, d))).toBe("deco");
    }
    expect(surpriseCandidates([])).toEqual(DESIGNS);
    expect(surpriseCandidates(null)).toEqual(DESIGNS);
    expect(surpriseCandidates(["vaporwave"])).toEqual(DESIGNS);
    // Picker order, deduped, unknown ids dropped.
    expect(surpriseCandidates(["matrix", "deco", "matrix", "zzz"])).toEqual(["deco", "matrix"]);
  });

  it("is deterministic and only picks favourites", () => {
    const s = { design: "kinozal" as DesignSetting, design_surprise: "day", design_favorites: ["matrix", "popart", "retro80", "deco"] };
    for (let d = 1; d <= 60; d++) {
      const a = effectiveDesign(s, P, at(2026, 10, d, 9));
      expect(s.design_favorites).toContain(a);
      expect(effectiveDesign(s, P, at(2026, 10, d, 21))).toBe(a);
    }
  });

  it("never shows the same design two periods in a row, and visits every favourite", () => {
    for (const favs of [["matrix", "deco"], ["matrix", "deco", "popart"], ["matrix", "deco", "popart", "retro90", "pocketpet"], [...DESIGNS]]) {
      const cands = surpriseCandidates(favs);
      for (const id of [P, "a", "b", "profile-42"]) {
        let prev: DesignSetting | null = null;
        const seen = new Set<DesignSetting>();
        for (let p = 20000; p < 20000 + cands.length * 12; p++) {
          const d = surprisePick(cands, id, p);
          expect(d).not.toBe(prev);
          prev = d;
          seen.add(d);
        }
        expect(seen.size).toBe(cands.length);
      }
    }
  });

  it("differs between profiles", () => {
    const s = { design: "kinozal" as DesignSetting, design_surprise: "day" };
    const days = (id: string) => Array.from({ length: 14 }, (_, i) => effectiveDesign(s, id, at(2026, 11, i + 1))).join();
    expect(days("profile-a")).not.toBe(days("profile-b"));
  });

  it("rolls over at local midnight", () => {
    expect(localDayIndex(at(2026, 11, 8, 0, 0))).toBe(localDayIndex(at(2026, 11, 7, 23, 59)) + 1);
    expect(localDayIndex(at(2026, 11, 7, 0, 0))).toBe(localDayIndex(at(2026, 11, 7, 23, 59)));
    const s = { design: "kinozal" as DesignSetting, design_surprise: "day" };
    expect(effectiveDesign(s, P, at(2026, 11, 7, 23, 59))).not.toBe(effectiveDesign(s, P, at(2026, 11, 8, 0, 1)));
    expect(nextSurpriseBoundary("day", at(2026, 11, 7, 15, 30)).getTime()).toBe(at(2026, 11, 8, 0, 0).getTime());
    // Month and year ends.
    expect(nextSurpriseBoundary("day", at(2026, 12, 31, 23)).getTime()).toBe(at(2027, 1, 1, 0).getTime());
  });

  it("weeks run Monday to Sunday (ISO)", () => {
    // 2026-11-09 is a Monday.
    const mon = surprisePeriod("week", at(2026, 11, 9, 0, 0));
    expect(surprisePeriod("week", at(2026, 11, 15, 23, 59))).toBe(mon);
    expect(surprisePeriod("week", at(2026, 11, 8, 23, 59))).toBe(mon - 1);
    expect(surprisePeriod("week", at(2026, 11, 16, 0, 0))).toBe(mon + 1);
    // Across a year end (2026-12-28 is a Monday; 2027-01-03 a Sunday).
    expect(surprisePeriod("week", at(2027, 1, 3))).toBe(surprisePeriod("week", at(2026, 12, 28)));
    const s = { design: "kinozal" as DesignSetting, design_surprise: "week", design_favorites: ["matrix", "deco", "popart"] };
    const week = effectiveDesign(s, P, at(2026, 11, 9, 8));
    for (let d = 9; d <= 15; d++) expect(effectiveDesign(s, P, at(2026, 11, d, 20))).toBe(week);
    expect(effectiveDesign(s, P, at(2026, 11, 16, 8))).not.toBe(week);
    expect(nextSurpriseBoundary("week", at(2026, 11, 7, 10)).getTime()).toBe(at(2026, 11, 9, 0).getTime());
    expect(nextSurpriseBoundary("week", at(2026, 11, 9, 0, 0)).getTime()).toBe(at(2026, 11, 16, 0).getTime());
  });
});

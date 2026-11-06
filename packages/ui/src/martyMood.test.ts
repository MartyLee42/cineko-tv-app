import { describe, expect, it } from "vitest";
import { martyMood } from "./martyMood";

// Local-time dates (months are 0-based in the Date constructor).
const at = (y: number, mo: number, d: number, h: number) => new Date(y, mo - 1, d, h, 30);

describe("martyMood", () => {
  it("2 am: a sleepy night line («Опять сериальчик?» among them)", () => {
    const keys = new Set([1, 2, 3, 4, 5, 6].map((d) => martyMood(at(2026, 11, d, 2)).key));
    expect(keys.has("marty.night_series")).toBe(true);
    for (const d of [1, 2, 3]) expect(["sleepy", "music"]).toContain(martyMood(at(2026, 11, d, 2)).mood);
  });
  it("weekend mornings say good morning, weekdays differ", () => {
    // 2026-11-07 is a Saturday, 2026-11-09 a Monday.
    expect(martyMood(at(2026, 11, 7, 9)).key).toMatch(/^marty\.weekend_morning/);
    expect(martyMood(at(2026, 11, 9, 9)).key).toMatch(/^marty\.morning/);
  });
  it("Friday evening: popcorn", () => {
    expect(martyMood(at(2026, 11, 6, 20))).toEqual({ key: "marty.friday", mood: "popcorn" });
  });
  it("holidays win", () => {
    expect(martyMood(at(2026, 12, 31, 21)).key).toBe("marty.new_year");
    expect(martyMood(at(2026, 10, 31, 22)).key).toBe("marty.halloween");
  });
  it("stays the same within a day slot", () => {
    expect(martyMood(at(2026, 11, 10, 13))).toEqual(martyMood(at(2026, 11, 10, 16)));
  });
});

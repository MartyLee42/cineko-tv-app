import { describe, expect, it } from "vitest";
import { petAte, petHearts, petMood, petScore, type PetProgress } from "./pocketpetMood";

const now = new Date("2026-11-07T20:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
const done = (days: number): { progress: PetProgress } => ({ progress: { completed: true, completed_at: ago(days), updated_at: ago(days), position_seconds: 5000 } });
const part = (days: number, min: number): { progress: PetProgress } => ({ progress: { completed: false, completed_at: null, updated_at: ago(days), position_seconds: min * 60 } });

describe("pocket pet mood", () => {
  it("counts finished titles of the last week, partial ones by minutes", () => {
    expect(petScore([], now)).toBe(0);
    expect(petScore([done(0.5), done(3), done(6.9)], now)).toBe(3);
    expect(petScore([done(8), part(9, 60)], now)).toBe(0);
    expect(petScore([part(1, 22.5)], now)).toBe(0.5);
    expect(petScore([part(1, 300)], now)).toBe(1);
  });

  it("uses updated_at when a finished entry has no completed_at", () => {
    expect(petScore([{ progress: { completed: true, completed_at: null, updated_at: ago(2), position_seconds: 0 } }], now)).toBe(1);
  });

  it("maps the score to 0–4 hearts and a mood", () => {
    expect([0, 0.9, 1, 2.9, 3, 6, 9.9, 10, 40].map(petHearts)).toEqual([0, 0, 1, 1, 2, 3, 3, 4, 4]);
    expect([0, 1, 2, 3, 4].map(petMood)).toEqual(["sad", "neutral", "neutral", "happy", "ecstatic"]);
  });

  it("eats a popcorn only when something new was watched since last time", () => {
    expect(petAte(null, 5)).toBe(false);
    expect(petAte(2, 2.5)).toBe(false);
    expect(petAte(2, 3)).toBe(true);
    expect(petAte(5, 3)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { BACKWARDS_EVERY_MS, BACKWARDS_MAX_CHARS, playsBackwards } from "./backwards";

const ids = Array.from({ length: 300 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
const base = { text: "Огни большого города", seen: new Set<string>(), now: 100_000, last: 0 };

describe("playsBackwards", () => {
  it("picks about a third of the titles, the same ones every time", () => {
    const hits = ids.filter((id) => playsBackwards({ ...base, id }));
    expect(hits.length).toBeGreaterThan(60);
    expect(hits.length).toBeLessThan(140);
    expect(ids.filter((id) => playsBackwards({ ...base, id }))).toEqual(hits);
  });

  it("plays at most once per card", () => {
    const id = ids.find((x) => playsBackwards({ ...base, id: x }))!;
    expect(playsBackwards({ ...base, id, seen: new Set([id]) })).toBe(false);
  });

  it("waits between two backwards titles", () => {
    const id = ids.find((x) => playsBackwards({ ...base, id: x }))!;
    expect(playsBackwards({ ...base, id, last: base.now - BACKWARDS_EVERY_MS + 1 })).toBe(false);
    expect(playsBackwards({ ...base, id, last: base.now - BACKWARDS_EVERY_MS })).toBe(true);
  });

  it("never plays long or empty titles, or cards without an id", () => {
    const id = ids.find((x) => playsBackwards({ ...base, id: x }))!;
    expect(playsBackwards({ ...base, id, text: "x".repeat(BACKWARDS_MAX_CHARS + 1) })).toBe(false);
    expect(playsBackwards({ ...base, id, text: " " })).toBe(false);
    expect(playsBackwards({ ...base, id: null })).toBe(false);
  });
});

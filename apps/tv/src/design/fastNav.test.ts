import { describe, expect, it } from "vitest";
import { FAST_GAP_MS, isFastPress } from "./fastNav";

describe("isFastPress", () => {
  it("repeating or quick presses are fast; a pause is not", () => {
    expect(isFastPress(1000, 900, false)).toBe(true);
    expect(isFastPress(1000, 1000 - FAST_GAP_MS - 1, false)).toBe(false);
    expect(isFastPress(5000, 0, true)).toBe(true);
    expect(isFastPress(5000, -Infinity, false)).toBe(false);
  });
});

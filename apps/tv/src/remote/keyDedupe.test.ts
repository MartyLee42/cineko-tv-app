import { describe, expect, it } from "vitest";
import { makeKeyFilter } from "./keyDedupe";

describe("makeKeyFilter", () => {
  it("drops an arrow repeated within a few ms (one press seen twice)", () => {
    const keep = makeKeyFilter();
    // From a real report: … 75 ms, 83 ms.
    expect([1000, 1075, 1083].map((t) => keep("ArrowRight", t))).toEqual([true, true, false]);
  });

  it("keeps held keys, quick presses and different keys", () => {
    const keep = makeKeyFilter();
    expect([0, 400, 450, 500, 550].map((t) => keep("ArrowDown", t))).toEqual([true, true, true, true, true]);
    expect(keep("ArrowRight", 555)).toBe(true);
    expect(keep("ArrowLeft", 560)).toBe(true);
  });
});

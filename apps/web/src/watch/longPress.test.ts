import { describe, expect, it } from "vitest";
import { MOVE_TOLERANCE_PX, movedTooFar } from "./longPress";

describe("movedTooFar", () => {
  it("a steady finger keeps the long press; a scroll or swipe cancels it", () => {
    const s = { x: 100, y: 200 };
    expect(movedTooFar(s, { x: 104, y: 197 })).toBe(false);
    expect(movedTooFar(s, { x: 100 + MOVE_TOLERANCE_PX, y: 200 })).toBe(false);
    expect(movedTooFar(s, { x: 100 + MOVE_TOLERANCE_PX + 1, y: 200 })).toBe(true);
    expect(movedTooFar(s, { x: 100, y: 170 })).toBe(true);
  });
});

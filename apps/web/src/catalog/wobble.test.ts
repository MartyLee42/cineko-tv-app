import { describe, expect, it, vi } from "vitest";

vi.mock("../watch/queries", () => ({ useSettings: () => ({ poster_wobble: true }) }));
const { MAX_TILT, tiltFor, tiltTransform } = await import("./wobble");

describe("poster tilt", () => {
  it("is flat with the pointer in the middle", () => {
    expect(tiltFor(50, 75, 100, 150)).toEqual({ rx: 0, ry: 0 });
  });
  it("leans toward the pointer, up to MAX_TILT", () => {
    // Right edge: rotateY positive (the right side dips away); top edge: rotateX positive.
    expect(tiltFor(100, 75, 100, 150)).toEqual({ rx: 0, ry: MAX_TILT });
    expect(tiltFor(0, 75, 100, 150)).toEqual({ rx: 0, ry: -MAX_TILT });
    expect(tiltFor(50, 0, 100, 150)).toEqual({ rx: MAX_TILT, ry: 0 });
    expect(tiltFor(50, 150, 100, 150)).toEqual({ rx: -MAX_TILT, ry: 0 });
    expect(tiltFor(75, 112.5, 100, 150)).toEqual({ rx: -MAX_TILT / 2, ry: MAX_TILT / 2 });
  });
  it("clamps outside the box and ignores empty boxes", () => {
    expect(tiltFor(-40, 900, 100, 150)).toEqual({ rx: -MAX_TILT, ry: -MAX_TILT });
    expect(tiltFor(10, 10, 0, 150)).toEqual({ rx: 0, ry: 0 });
    expect(tiltFor(10, 10, 100, Number.NaN)).toEqual({ rx: 0, ry: 0 });
    expect(Math.abs(tiltFor(33, 47, 100, 150, 4).ry)).toBeLessThanOrEqual(4);
  });
  it("never writes -0", () => {
    expect(Object.is(tiltFor(50, 75, 100, 150).rx, -0)).toBe(false);
  });
  it("builds a perspective transform", () => {
    expect(tiltTransform({ rx: 1.5, ry: -3 })).toBe("perspective(700px) translateY(-2px) rotateX(1.5deg) rotateY(-3deg) scale(1.02)");
  });
});

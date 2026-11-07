import { describe, expect, it } from "vitest";
import { rebufferOutrun } from "./rebuffer";

describe("a rebuffer something else ended", () => {
  it("ends when the video plays on past where the rebuffer began", () => {
    expect(rebufferOutrun({ paused: false, readyState: 4, time: 101, timeAtStart: 100 })).toBe(true);
  });
  it("holds while paused, not ready, or not moving yet", () => {
    expect(rebufferOutrun({ paused: true, readyState: 4, time: 130, timeAtStart: 100 })).toBe(false);
    expect(rebufferOutrun({ paused: false, readyState: 2, time: 130, timeAtStart: 100 })).toBe(false);
    expect(rebufferOutrun({ paused: false, readyState: 4, time: 100.2, timeAtStart: 100 })).toBe(false);
  });
});

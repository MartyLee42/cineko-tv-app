import { describe, expect, it } from "vitest";
import { isRealEnd, isUnexplainedDrop, isUnexplainedJump, seekMissed } from "./glitch";

describe("seekMissed", () => {
  it("an engine that dropped the start seek plays near 0", () => {
    expect(seekMissed(0.4, 4796)).toBe(true);
    expect(seekMissed(4790, 4796)).toBe(false);
    // Keyframe / segment snapping is fine.
    expect(seekMissed(4788, 4796)).toBe(false);
    expect(seekMissed(NaN, 4796)).toBe(false);
  });
});

describe("isRealEnd", () => {
  it("a 45-min episode cut off at 12 min is not the end", () => {
    expect(isRealEnd(720, 2700, 730)).toBe(false);
  });
  it("credits: within the last 90 s (or 3%) counts as the end", () => {
    expect(isRealEnd(2650, 2700, 2700)).toBe(true);
    // 2 h film: the window is 3% = 216 s
    expect(isRealEnd(7000, 7200, null)).toBe(true);
    expect(isRealEnd(6900, 7200, null)).toBe(false);
  });
  it("the server duration wins over a shortened engine duration", () => {
    expect(isRealEnd(728, 2700, 730)).toBe(false);
  });
  it("unknown length: trust the engine", () => {
    expect(isRealEnd(38, null, 40)).toBe(true);
    expect(isRealEnd(0, null, null)).toBe(true);
  });
});

describe("isUnexplainedJump", () => {
  it("a big jump without a seek is a glitch", () => {
    expect(isUnexplainedJump(2690, 700, false)).toBe(true);
  });
  it("normal playback and user seeks are fine", () => {
    expect(isUnexplainedJump(705, 700, false)).toBe(false);
    expect(isUnexplainedJump(2690, 700, true)).toBe(false);
  });
});

describe("isUnexplainedDrop", () => {
  it("flags the engine restarting from the start without a seek", () => {
    expect(isUnexplainedDrop(3, 2400, false)).toBe(true);
    expect(isUnexplainedDrop(2390, 2400, false)).toBe(false); // small wobble
    expect(isUnexplainedDrop(3, 2400, true)).toBe(false); // the viewer seeked back
  });
});

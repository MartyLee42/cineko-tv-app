import { describe, expect, it } from "vitest";
import { beyondTarget, isRealEnd, isUnexplainedDrop, isUnexplainedJump, seekMissed, shownPosition, truncatedLength } from "./glitch";

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

describe("shownPosition", () => {
  it("holds the resume spot while the engine still reads 0 (no 0 ↔ resume flicker)", () => {
    expect(shownPosition({ time: 0, lastGood: 1800, target: 1800, seekWindow: true })).toBe(1800);
    expect(shownPosition({ time: 1801, lastGood: 1800, target: 1800, seekWindow: true })).toBe(1801);
  });
  it("never shows the end of the film when the network drops", () => {
    // Right after a (re)load: the engine leaps to the end.
    expect(shownPosition({ time: 7190, lastGood: 1800, target: 1800, seekWindow: true })).toBe(1800);
    // Later in playback.
    expect(shownPosition({ time: 7190, lastGood: 2400, target: 1800, seekWindow: false })).toBe(2400);
    // …or restarts from the start.
    expect(shownPosition({ time: 2, lastGood: 2400, target: 1800, seekWindow: false })).toBe(2400);
  });
  it("normal playback and a landed seek show the engine's time", () => {
    expect(shownPosition({ time: 2405, lastGood: 2400, target: 1800, seekWindow: false })).toBe(2405);
    expect(shownPosition({ time: 300, lastGood: 300, target: 300, seekWindow: true })).toBe(300);
  });
  it("a NaN time shows the target", () => {
    expect(shownPosition({ time: NaN, lastGood: 10, target: 600, seekWindow: true })).toBe(600);
  });
});

describe("beyondTarget / truncatedLength", () => {
  it("a jump past the seek's target is not explained by that seek", () => {
    expect(beyondTarget(7190, 1800)).toBe(true);
    expect(beyondTarget(1810, 1800)).toBe(false);
    expect(beyondTarget(7190, null)).toBe(false);
  });
  it("an engine length far shorter than ffprobe's is a cut-off stream", () => {
    expect(truncatedLength(1900, 7200)).toBe(true);
    expect(truncatedLength(7199.5, 7200)).toBe(false);
    expect(truncatedLength(1900, null)).toBe(false);
  });
});

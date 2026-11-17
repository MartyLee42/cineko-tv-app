import { describe, expect, it } from "vitest";
import { foldOf, lampSeconds, stationOf } from "./loaderSteps";
import { loaderKind } from "./loaderChunks";

describe("«Поезд прибывает»", () => {
  it("passes a station per load phase", () => {
    expect(["resolving", "searching", "creating", "metadata", "preloading", "starting", "done"].map((s) => stationOf(s as never))).toEqual([0, 0, 1, 1, 2, 3, 3]);
  });

  it("rushes the lamps faster as the buffer fills, in a few steps only", () => {
    const speeds = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1].map(lampSeconds);
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]).toBeLessThanOrEqual(speeds[i - 1]!);
    expect(new Set(speeds).size).toBeLessThanOrEqual(5);
    expect(lampSeconds(-1)).toBe(lampSeconds(0));
    expect(lampSeconds(2)).toBe(lampSeconds(1));
  });

  it("is what «Метро» always shows (not in Settings' previews)", () => {
    expect(loaderKind("popcorn", "metro")).toBe("metro_train");
    expect(loaderKind("paper_crane", "metro")).toBe("metro_train");
    expect(loaderKind("paper_crane", "metro", true)).toBe("paper_crane");
    expect(loaderKind("metro_train", "kinozal")).toBe("metro_train");
  });
});

describe("«Журавлик»", () => {
  it("folds step by step and is a crane once done", () => {
    expect([0, 0.19, 0.2, 0.45, 0.7, 0.9].map((p) => foldOf(p, false))).toEqual([0, 0, 1, 2, 3, 4]);
    expect(foldOf(0.1, true)).toBe(4);
  });
});

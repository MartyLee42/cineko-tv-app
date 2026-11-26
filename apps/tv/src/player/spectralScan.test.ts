import { describe, expect, it } from "vitest";
import { scanBloom, scanReveal } from "./loaderSteps";
import { loaderKind } from "./loaderChunks";

describe("«Спектральный скан»", () => {
  it("lights the band in whole slices, never backwards, all of it once done", () => {
    const r = [0, 0.03, 0.2, 0.5, 0.77, 0.999].map((p) => scanReveal(p, false));
    for (let i = 1; i < r.length; i++) expect(r[i]).toBeGreaterThanOrEqual(r[i - 1]!);
    for (const v of r) expect(Math.round(v * 24)).toBeCloseTo(v * 24, 6);
    expect(scanReveal(0.5, true)).toBe(1);
    expect(scanReveal(-1, false)).toBe(0);
    expect(scanReveal(5, false)).toBe(1);
  });

  it("keeps the bloom small while loading and opens it at 100 %", () => {
    expect(scanBloom(0, false)).toBeCloseTo(0.12, 3);
    expect(scanBloom(0.99, false)).toBeLessThan(0.5);
    expect(scanBloom(0.4, true)).toBe(1);
  });

  it("is what «Репликант» always shows (not in Settings' previews)", () => {
    expect(loaderKind("popcorn", "replicant")).toBe("spectral_scan");
    expect(loaderKind("popcorn", "replicant", true)).toBe("popcorn");
    expect(loaderKind("spectral_scan", "kinozal")).toBe("spectral_scan");
  });
});

import { describe, expect, it } from "vitest";
import { count, enough, funnelSteps, pct, sourceRows, trend, type SourceWeight } from "./quality";

const w = (source: string, weight: number, prev = 1): SourceWeight => ({
  source,
  weight,
  prev_weight: prev,
  target: weight,
  impressions: 40.5,
  opens: 4,
  plays: 2,
  completes: 1,
  dismisses: 0,
});

describe("quality helpers", () => {
  it("formats shares and counts", () => {
    expect(pct(0.674, "en")).toBe("67 %");
    expect(pct(null, "en")).toBe("—");
    expect(count(12, "en")).toBe("12");
    expect(count(2.25, "en")).toBe("2.3");
    expect(enough(4)).toBe(false);
    expect(enough(5)).toBe(true);
  });

  it("tells the last step", () => {
    expect(trend(w("a", 1.15))).toBe("up");
    expect(trend(w("a", 0.85))).toBe("down");
    expect(trend(w("a", 1, 1))).toBe("same");
  });

  it("builds the funnel with shares of shown", () => {
    const steps = funnelSteps({ shown: 20, played: 5, finished: 2, rated: 4, liked: 3, disliked: 1 });
    expect(steps.map((s) => s.key)).toEqual(["shown", "played", "finished", "rated", "liked"]);
    expect(steps[1]!).toEqual({ key: "played", n: 5, share: 0.25 });
    expect(funnelSteps({ shown: 0, played: 0, finished: 0, rated: 0, liked: 0, disliked: 0 })[0]?.share).toBeNull();
  });

  it("joins weights and per-source quality in source order", () => {
    const rows = sourceRows(
      ["trending", "director", "theme"],
      [w("director", 1.15), w("trending", 0.85)],
      [
        { source: "director", shown: 3, plays: 2, rated: 2, avg: 8.5, liked: 1 },
        { source: "theme", shown: 1, plays: 1, rated: 0, avg: null, liked: null },
        { source: "odd", shown: 1, plays: 0, rated: 0, avg: null, liked: null },
      ],
    );
    expect(rows.map((r) => r.source)).toEqual(["trending", "director", "theme", "odd"]);
    expect(rows[1]).toMatchObject({ shown: 40.5, opens: 4, plays: 2, avg: 8.5, liked: 1 });
    expect(rows[1]!.weight?.weight).toBe(1.15);
    // Without a learned weight the quality counts stand in.
    expect(rows[2]).toMatchObject({ shown: 1, plays: 1, weight: null, avg: null });
    expect(sourceRows(["trending"], undefined, undefined)).toEqual([]);
  });
});

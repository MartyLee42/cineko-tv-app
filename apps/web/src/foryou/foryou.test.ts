import { describe, expect, it } from "vitest";
import {
  anyRunning,
  arcPath,
  calendarWeeks,
  currentMonth,
  divergingBar,
  FeedbackQueue,
  histogramBars,
  parseMonth,
  percent,
  runProgress,
  shiftMonth,
  splitAffinities,
} from "./logic";

describe("diary calendar", () => {
  it("lays out a month in Monday-first weeks", () => {
    // 1 Oct 2026 is a Thursday.
    const w = calendarWeeks("2026-10");
    expect(w).toHaveLength(5);
    expect(w[0]!.map((c) => c.day)).toEqual([null, null, null, 1, 2, 3, 4]);
    expect(w[4]!.map((c) => c.day)).toEqual([26, 27, 28, 29, 30, 31, null]);
    expect(w[0]![3]!.date).toBe("2026-10-01");
    expect(w.every((x) => x.length === 7)).toBe(true);
  });
  it("handles a month starting on Monday and leap February", () => {
    // 1 Feb 2027 is a Monday; Feb 2028 has 29 days.
    expect(calendarWeeks("2027-02")[0]![0]!.day).toBe(1);
    expect(calendarWeeks("2027-02")).toHaveLength(4);
    const feb = calendarWeeks("2028-02").flat().filter((c) => c.day);
    expect(feb).toHaveLength(29);
  });
  it("moves between months and validates ?month=", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(currentMonth(new Date("2026-10-29T12:00:00Z"))).toBe("2026-10");
    expect(parseMonth("2026-13")).toBeNull();
    expect(parseMonth("2026-07")).toBe("2026-07");
    expect(parseMonth(null)).toBeNull();
  });
});

describe("taste geometry", () => {
  it("scales histogram bars to the tallest", () => {
    const bars = histogramBars([0, 5, 10], 100, 50, 5);
    expect(bars.map((b) => b.h)).toEqual([0, 25, 50]);
    expect(bars[2]!.y).toBe(0);
    expect(bars[1]!.x).toBeCloseTo(35);
    expect(bars[0]!.w).toBeCloseTo(30);
    expect(histogramBars([], 100, 50)).toEqual([]);
    // Tiny non-zero values stay visible.
    expect(histogramBars([1, 1000], 100, 50)[0]!.h).toBe(2);
  });
  it("draws diverging bars around the centre", () => {
    expect(divergingBar(0.5)).toEqual({ left: 50, width: 25 });
    expect(divergingBar(-1)).toEqual({ left: 0, width: 50 });
    expect(divergingBar(3)).toEqual({ left: 50, width: 50 });
  });
  it("splits likes and dislikes", () => {
    const a = [{ score: 0.2 }, { score: -0.5 }, { score: 0.9 }, { score: 0 }, { score: -0.1 }];
    const { likes, dislikes } = splitAffinities(a);
    expect(likes.map((x) => x.score)).toEqual([0.9, 0.2]);
    expect(dislikes.map((x) => x.score)).toEqual([-0.5, -0.1]);
  });
  it("computes percentages and donut arcs", () => {
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(1, 0)).toBe(0);
    expect(arcPath(50, 50, 40, 0, 0.25)).toBe("M 50 10 A 40 40 0 0 1 90 50");
    expect(arcPath(50, 50, 40, 0, 0.75)).toContain(" 0 1 1 ");
    expect(arcPath(50, 50, 40, 0, 1).match(/A /g)).toHaveLength(2);
  });
});

describe("feedback queue", () => {
  it("dedupes impressions per row and batches by 100", () => {
    const q = new FeedbackQueue();
    expect(q.add({ media_id: "a", action: "impression", row_id: "r1" })).toBe(true);
    expect(q.add({ media_id: "a", action: "impression", row_id: "r1" })).toBe(false);
    expect(q.add({ media_id: "a", action: "impression", row_id: "r2" })).toBe(true);
    expect(q.add({ media_id: "a", action: "open", row_id: "r1" })).toBe(true);
    expect(q.add({ media_id: "a", action: "open", row_id: "r1" })).toBe(true);
    expect(q.size).toBe(4);
    for (let i = 0; i < 150; i++) q.add({ media_id: `m${i}`, action: "impression", row_id: "r" });
    expect(q.flush()).toHaveLength(100);
    expect(q.flush()).toHaveLength(54);
    expect(q.flush()).toHaveLength(0);
  });
});

describe("admin runs", () => {
  it("reports progress", () => {
    expect(runProgress({ status: "running", profiles_total: 4, profiles_done: 1 })).toBe(0.25);
    expect(runProgress({ status: "running", profiles_total: 0, profiles_done: 0 })).toBe(0);
    expect(runProgress({ status: "failed", profiles_total: 4, profiles_done: 1 })).toBe(0.25);
    expect(runProgress({ status: "completed", profiles_total: 4, profiles_done: 3 })).toBe(1);
    expect(anyRunning([{ status: "completed", profiles_total: 1, profiles_done: 1 }])).toBe(false);
    expect(anyRunning([{ status: "running", profiles_total: 1, profiles_done: 0 }])).toBe(true);
  });
});

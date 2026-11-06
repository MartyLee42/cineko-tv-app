import { describe, expect, it } from "vitest";
import {
  diskLevel,
  formatBytes,
  formatLoad,
  formatPercent,
  formatRate,
  formatUptime,
  level,
  loadLevel,
  niceMax,
  percentOf,
  ramLevel,
  swapLevel,
  worst,
} from "./format";
import { buildPath, chartPoints } from "./chart";

const nbsp = (s: string) => s.replace(/\u00a0/g, " ");

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1536, "1.5 KB"],
    [8 * 1024 ** 3, "8 GB"],
    [7.8 * 1024 ** 3, "7.8 GB"],
    [123 * 1024 ** 2, "123 MB"],
    [3 * 1024 ** 4, "3 TB"],
  ])("%d → %s", (n, want) => expect(formatBytes(n)).toBe(want));
  it("localizes units and decimals", () => expect(nbsp(formatBytes(1536, "ru"))).toBe("1,5 КБ"));
  it("handles missing values", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("formatRate", () => {
  it.each([
    [0, "0 bit/s"],
    [100, "800 bit/s"],
    [125_000, "1 Mbit/s"],
    [1_562_500, "13 Mbit/s"],
    [562_500, "4.5 Mbit/s"],
    [250_000_000, "2 Gbit/s"],
  ])("%d B/s → %s", (n, want) => expect(formatRate(n)).toBe(want));
  it("ru", () => expect(nbsp(formatRate(562_500, "ru"))).toBe("4,5 Мбит/с"));
});

describe("formatPercent / percentOf", () => {
  it("formats", () => {
    expect(formatPercent(42.34)).toBe("42%");
    expect(formatPercent(4.27)).toBe("4.3%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(null)).toBe("—");
  });
  it("is safe for zero totals", () => {
    expect(percentOf(5, 0)).toBe(0);
    expect(percentOf(1, 4)).toBe(25);
    expect(percentOf(9, 4)).toBe(100);
  });
});

describe("formatUptime / formatLoad", () => {
  it("formats uptime", () => {
    expect(formatUptime(93784)).toBe("1d 2h");
    expect(formatUptime(3 * 3600 + 5 * 60)).toBe("3h 5m");
    expect(formatUptime(720)).toBe("12m");
    expect(formatUptime(93784, "ru")).toBe("1 д 2 ч");
  });
  it("formats load", () => {
    expect(formatLoad(1.5)).toBe("1.50");
    expect(formatLoad(0.256, "ru")).toBe("0,26");
  });
});

describe("thresholds", () => {
  it("levels", () => {
    expect(level(50, [85, 95])).toBe("ok");
    expect(level(85, [85, 95])).toBe("ok");
    expect(level(86, [85, 95])).toBe("warn");
    expect(level(95, [85, 95])).toBe("crit");
  });
  it("RAM over 85% warns", () => {
    expect(ramLevel(6, 8)).toBe("ok");
    expect(ramLevel(7, 8)).toBe("warn");
    expect(ramLevel(7.8, 8)).toBe("crit");
  });
  it("swap: heavy use warns, no swap is fine", () => {
    expect(swapLevel(1, 4)).toBe("ok");
    expect(swapLevel(2.5, 4)).toBe("warn");
    expect(swapLevel(3.5, 4)).toBe("crit");
    expect(swapLevel(0, 0)).toBe("ok");
  });
  it("load over the core count warns", () => {
    expect(loadLevel(3.9, 4)).toBe("ok");
    expect(loadLevel(4.5, 4)).toBe("warn");
    expect(loadLevel(8, 4)).toBe("crit");
    expect(loadLevel(8, 0)).toBe("ok");
  });
  it("disk over 90% warns", () => {
    expect(diskLevel(80, 100)).toBe("ok");
    expect(diskLevel(91, 100)).toBe("warn");
    expect(diskLevel(96, 100)).toBe("crit");
  });
  it("worst", () => {
    expect(worst("ok", "warn")).toBe("warn");
    expect(worst("warn", "crit", "ok")).toBe("crit");
    expect(worst()).toBe("ok");
  });
});

describe("chart helpers", () => {
  it("niceMax", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(0.7)).toBe(1);
    expect(niceMax(3.2)).toBe(4);
    expect(niceMax(730)).toBe(1000);
    expect(niceMax(100)).toBe(100);
  });
  it("places points on a fixed time window and breaks gaps", () => {
    const end = Date.parse("2026-10-29T12:00:00Z");
    const t = (sec: number) => new Date(end - sec * 1000).toISOString();
    const pts = chartPoints(
      [
        { t: t(3600), v: 0 },
        { t: t(3590), v: 50 },
        { t: t(1800), v: 100 }, // gap before → new segment
        { t: t(0), v: 25 },
      ],
      end,
      60,
      100,
    );
    expect(pts.map((p) => [Math.round(p.x * 100), p.y, p.gap])).toEqual([
      [0, 1, false],
      [0, 0.5, false],
      [50, 0, true],
      [100, 0.75, true],
    ]);
    expect(buildPath(pts, 200, 100)).toBe("M0,100L0.6,50M100,0M200,75");
  });
});

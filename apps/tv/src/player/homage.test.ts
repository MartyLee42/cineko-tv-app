import { describe, expect, it } from "vitest";
import {
  beeCount,
  chocolateLines,
  chocolatesEaten,
  CHOCOLATES,
  clawPose,
  hashSeed,
  lineFor,
  meterLights,
  needleAngle,
  rippleRings,
  rippleStrength,
  runtimeLabel,
  seeded,
  StallTracker,
} from "./homage";

describe("ripples", () => {
  it("grow from faint to full and never leave 0.15..1", () => {
    expect(rippleStrength(0)).toBe(0.15);
    expect(rippleStrength(1)).toBe(1);
    expect(rippleStrength(-1)).toBe(0.15);
    expect(rippleStrength(2)).toBe(1);
    expect(rippleStrength(0.5)).toBeGreaterThan(0.15);
    expect(rippleStrength(0.5)).toBeLessThan(rippleStrength(0.8));
  });
  it("one ring at first, three later", () => {
    expect(rippleRings(0)).toBe(1);
    expect(rippleRings(0.4)).toBe(2);
    expect(rippleRings(0.7)).toBe(3);
    expect(rippleRings(1)).toBe(3);
  });
});

describe("chocolates", () => {
  it("one goes every 1/12, all at 100 %", () => {
    expect(chocolatesEaten(0)).toBe(0);
    expect(chocolatesEaten(0.08)).toBe(0);
    expect(chocolatesEaten(1 / 12)).toBe(1);
    expect(chocolatesEaten(0.5)).toBe(6);
    expect(chocolatesEaten(0.99)).toBe(11);
    expect(chocolatesEaten(1)).toBe(CHOCOLATES);
    expect(chocolatesEaten(1.3)).toBe(CHOCOLATES);
    expect(chocolatesEaten(0.5, 10)).toBe(5);
  });
  it("facts first (spoiler-free, trimmed, capped), Details lines to fill up", () => {
    const long = "x".repeat(300);
    const lines = chocolateLines([" Снимали зимой. ", "", long], { year: 1994, genres: [{ name: "Драма" }], crew: [{ name: "Р. Режиссёров", job: "Director" }, { name: "Кто-то", job: "Writer" }], runtime: 142 }, (m) => `${m} мин`);
    expect(lines[0]).toEqual({ text: "Снимали зимой." });
    expect("text" in lines[1]! && lines[1].text.length).toBe(178);
    expect(lines).toContainEqual({ key: "loaders2.fact.genres", v: "драма" });
    expect(lines).toContainEqual({ key: "loaders2.fact.year", v: "1994" });
    expect(lines).toContainEqual({ key: "loaders2.fact.director", v: "Р. Режиссёров" });
    expect(lines).toContainEqual({ key: "loaders2.fact.runtime", v: "142 мин" });
  });
  it("enough facts: no Details lines; nothing at all: empty", () => {
    expect(chocolateLines(["a", "b", "c", "d"], { year: 2000 }, () => null)).toHaveLength(4);
    expect(chocolateLines(null, null, () => null)).toEqual([]);
  });
  it("each chocolate picks a line, spread from a seed-chosen start", () => {
    const xs = ["a", "b", "c"];
    expect(lineFor(xs, 0, "s")).toBeNull();
    expect(lineFor([], 1, "s")).toBeNull();
    const first = lineFor(xs, 1, "s");
    const second = lineFor(xs, 2, "s");
    expect(first).not.toBe(second);
    expect(lineFor(xs, 4, "s")).toBe(first);
  });
});

describe("StallTracker", () => {
  it("stalls after 6 s without a 0.5 % step, clears on a step", () => {
    const s = new StallTracker(6000, 0.005);
    expect(s.update(0.2, 0)).toBe(false);
    expect(s.update(0.202, 3000)).toBe(false);
    expect(s.update(0.204, 6000)).toBe(true);
    expect(s.update(0.21, 6500)).toBe(false);
    expect(s.update(0.21, 12400)).toBe(false);
    expect(s.update(0.21, 12500)).toBe(true);
  });
  it("a finished load is never stalled", () => {
    const s = new StallTracker(1000);
    s.update(1, 0);
    expect(s.update(1, 5000)).toBe(false);
  });
});

describe("meter", () => {
  it("maps progress onto the dial", () => {
    expect(needleAngle(0)).toBe(-66);
    expect(needleAngle(0.5)).toBe(0);
    expect(needleAngle(1)).toBe(66);
    expect(needleAngle(5)).toBe(66);
    expect(needleAngle(0.25, 0, 100)).toBe(25);
  });
  it("lights: at least one, all at the top", () => {
    expect(meterLights(0)).toBe(1);
    expect(meterLights(0.5)).toBe(4);
    expect(meterLights(0.51)).toBe(5);
    expect(meterLights(1)).toBe(8);
  });
});

describe("beeCount", () => {
  it("one bee per three peers, capped", () => {
    expect(beeCount(null)).toBe(0);
    expect(beeCount(0)).toBe(0);
    expect(beeCount(-3)).toBe(0);
    expect(beeCount(1)).toBe(1);
    expect(beeCount(3)).toBe(1);
    expect(beeCount(4)).toBe(2);
    expect(beeCount(17)).toBe(6);
    expect(beeCount(500)).toBe(10);
    expect(beeCount(500, 4)).toBe(4);
  });
});

describe("runtimeLabel", () => {
  it("hours and minutes", () => {
    expect(runtimeLabel(142)).toEqual({ key: "loaders2.time.hm", vars: { h: 2, m: 22 } });
    expect(runtimeLabel(120)).toEqual({ key: "loaders2.time.h", vars: { h: 2 } });
    expect(runtimeLabel(45)).toEqual({ key: "loaders2.time.m", vars: { m: 45 } });
    expect(runtimeLabel(null)).toBeNull();
    expect(runtimeLabel(0)).toBeNull();
  });
});

describe("clawPose", () => {
  it("travels, lowers, grips, carries and lets go", () => {
    expect(clawPose(0)).toMatchObject({ x: 0, drop: 0, closed: false, holding: false });
    expect(clawPose(0.25)).toMatchObject({ x: 1, drop: 0, holding: false });
    expect(clawPose(0.55)).toMatchObject({ x: 1, drop: 1, closed: true, holding: true });
    const mid = clawPose(0.95);
    expect(mid.holding).toBe(true);
    expect(mid.x).toBeCloseTo(0.5);
    expect(clawPose(1)).toMatchObject({ x: 0, holding: false, released: true });
  });
});

describe("seeded", () => {
  it("is deterministic per seed, in 0..1", () => {
    const a = seeded(hashSeed("x"));
    const b = seeded(hashSeed("x"));
    for (let i = 0; i < 20; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(hashSeed("a")).not.toBe(hashSeed("b"));
  });
});

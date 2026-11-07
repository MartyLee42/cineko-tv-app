import { describe, expect, it } from "vitest";
import {
  alignment,
  balloonsAt,
  balloonSpot,
  BALLOONS_TOTAL,
  fishAt,
  FISH_TOTAL,
  isStalled,
  latestFish,
  lookAt,
  monolithRise,
  mphAt,
  needleAngle,
  pawSteps,
  PAW_STEPS,
  stallStep,
  STALL_MS,
  stepsAt,
} from "./logic";

const nonDecreasing = (xs: number[]) => xs.every((x, i) => i === 0 || x >= xs[i - 1]!);
const ps = Array.from({ length: 101 }, (_, i) => i / 100);

describe("drawn loading styles", () => {
  it("steps: whole steps reached, clamped, all at 1", () => {
    expect(stepsAt(0, 20)).toBe(0);
    expect(stepsAt(0.049, 20)).toBe(0);
    expect(stepsAt(0.05, 20)).toBe(1);
    expect(stepsAt(1, 20)).toBe(20);
    expect(stepsAt(7, 20)).toBe(20);
    expect(stepsAt(NaN, 20)).toBe(0);
  });

  it("paws: one per 5 %, never fewer as progress grows", () => {
    expect(PAW_STEPS).toBe(20);
    expect(pawSteps(0.5)).toBe(10);
    expect(pawSteps(0.95)).toBe(19);
    expect(nonDecreasing(ps.map(pawSteps))).toBe(true);
  });

  it("stall: the last paw taps after STALL_MS without a rise", () => {
    let s = stallStep(null, 0.3, 0);
    expect(isStalled(s, STALL_MS - 1)).toBe(false);
    expect(isStalled(s, STALL_MS)).toBe(true);
    // Same value again: still stalled since 0.
    s = stallStep(s, 0.3, STALL_MS + 500);
    expect(isStalled(s, STALL_MS + 500)).toBe(true);
    // A rise resets it.
    s = stallStep(s, 0.31, STALL_MS + 600);
    expect(isStalled(s, STALL_MS + 700)).toBe(false);
    // Finished never "stalls".
    expect(isStalled(stallStep(null, 1, 0), 60_000)).toBe(false);
  });

  it("fish: one per 1/FISH_TOTAL, stable places inside the bowl", () => {
    expect(fishAt(0)).toEqual([]);
    expect(fishAt(1)).toHaveLength(FISH_TOTAL);
    const a = fishAt(0.5);
    const b = fishAt(0.6);
    expect(b.slice(0, a.length)).toEqual(a);
    for (const f of fishAt(1)) {
      expect(f.x).toBeGreaterThan(0.1);
      expect(f.x).toBeLessThan(0.9);
      expect(f.y).toBeGreaterThan(0.1);
      expect(f.y).toBeLessThan(0.8);
    }
    expect(latestFish(0)).toBeNull();
    expect(latestFish(1)?.i).toBe(FISH_TOTAL - 1);
  });

  it("eyes look towards a point (unit vector)", () => {
    expect(lookAt(0, 0, 10, 0)).toEqual({ dx: 1, dy: 0 });
    const l = lookAt(100, 100, 0, 0);
    expect(l.dx).toBeCloseTo(-Math.SQRT1_2);
    expect(l.dy).toBeCloseTo(-Math.SQRT1_2);
    expect(lookAt(5, 5, 5, 5)).toEqual({ dx: 0, dy: 0 });
  });

  it("speedometer: 0 → 88 mph, needle over -120°..120°", () => {
    expect(mphAt(0)).toBe(0);
    expect(mphAt(0.5)).toBe(44);
    expect(mphAt(1)).toBe(88);
    expect(needleAngle(0)).toBe(-120);
    expect(needleAngle(50)).toBe(0);
    expect(needleAngle(500)).toBe(120);
    expect(nonDecreasing(ps.map((p) => needleAngle(mphAt(p))))).toBe(true);
  });

  it("odyssey: the monolith stands before the end, the bodies align at 1", () => {
    expect(monolithRise(0)).toBe(0);
    expect(monolithRise(0.85)).toBe(1);
    expect(alignment(1)).toBe(1);
    expect(nonDecreasing(ps.map(monolithRise))).toBe(true);
    expect(nonDecreasing(ps.map(alignment))).toBe(true);
  });

  it("balloons: one per ~7 %, each with its own spot", () => {
    expect(balloonsAt(1)).toBe(BALLOONS_TOTAL);
    expect(balloonsAt(1 / BALLOONS_TOTAL)).toBe(1);
    expect(nonDecreasing(ps.map(balloonsAt))).toBe(true);
    const spots = Array.from({ length: BALLOONS_TOTAL }, (_, i) => balloonSpot(i));
    for (let i = 0; i < spots.length; i++)
      for (let j = i + 1; j < spots.length; j++) expect(Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.y - spots[j]!.y)).toBeGreaterThan(20);
  });
});

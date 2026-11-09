import { describe, expect, it } from "vitest";
import { burstPoints, floorLines, hillPath, rainStreaks, rand, skyline, starField, starPath, sunGaps, wireRidge } from "./geometry";

describe("decor geometry", () => {
  it("rand is deterministic and stays in (0, 1)", () => {
    const a = rand(7);
    const b = rand(7);
    for (let i = 0; i < 50; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("wireRidge starts and ends on the horizon, peaks above it", () => {
    const { poly, wires } = wireRidge(-40, 760, 230, 3, 600);
    const pts = poly.split(" ").map((p) => p.split(",").map(Number));
    expect(pts[0]).toEqual([-40, 600]);
    expect(pts[pts.length - 1]).toEqual([760, 600]);
    for (const [, y] of pts.slice(1, -1)) expect(y).toBeLessThan(600);
    expect(wires).toHaveLength((pts.length - 2) * 3);
    for (const w of wires) expect(w[3]).toBe(600);
    expect(wireRidge(-40, 760, 230, 3, 600)).toEqual({ poly, wires });
  });

  it("starField fits the sky", () => {
    const s = starField(40, 11, 1280, 380);
    expect(s).toHaveLength(40);
    for (const st of s) {
      expect(st.x).toBeGreaterThanOrEqual(0);
      expect(st.x).toBeLessThanOrEqual(1280);
      expect(st.y).toBeLessThanOrEqual(380);
      expect(st.o).toBeGreaterThan(0.3);
      expect(st.o).toBeLessThan(0.9);
    }
  });

  it("sun gaps widen and spread towards the horizon", () => {
    const g = sunGaps(7, 470, 21, 1.5, 3, 2.2);
    for (let i = 1; i < g.length; i++) {
      expect(g[i]!.h).toBeGreaterThan(g[i - 1]!.h);
      expect(g[i]!.y - g[i - 1]!.y).toBeGreaterThan(20);
    }
  });

  it("burstPoints has two points per spike", () => {
    expect(burstPoints(150, 108, 66, 98, 13, 9).split(" ")).toHaveLength(26);
  });

  it("starPath is a closed ten-point path", () => {
    const d = starPath(20);
    expect(d.startsWith("M0.0,-20.0")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d.split("L")).toHaveLength(10);
  });

  it("hillPath is closed along the bottom across the full width", () => {
    const d = hillPath(938, [[18, 900, 0.4]], 1920, 1080, 40);
    expect(d.startsWith("M0 1080 L0 938")).toBe(true);
    expect(d.endsWith("L1920 1080 Z")).toBe(true);
  });

  it("rainStreaks are faint", () => {
    for (const [, , len, o] of rainStreaks(30, 1972, 1960, 1000)) {
      expect(len).toBeGreaterThanOrEqual(40);
      expect(o).toBeLessThan(0.17);
    }
  });

  it("skyline covers the width, windows inside their building", () => {
    const b = skyline(23, 1920, 1080);
    expect(b[0]!.x).toBe(0);
    expect(b[b.length - 1]!.x + b[b.length - 1]!.w).toBeGreaterThanOrEqual(1920);
    for (const bl of b) for (const w of bl.win) {
      expect(w.x).toBeGreaterThanOrEqual(bl.x);
      expect(w.x).toBeLessThanOrEqual(bl.x + bl.w);
      expect(w.y).toBeGreaterThanOrEqual(1080 - bl.h);
    }
  });

  it("floor lines keep a constant ratio", () => {
    const l = floorLines(760, 0.78, 22);
    for (let i = 1; i < l.length; i++) expect(l[i]! / l[i - 1]!).toBeCloseTo(0.78, 6);
    expect(Math.min(...l)).toBeGreaterThan(3);
  });
});

import { describe, expect, it } from "vitest";
import { steadyAt } from "./steady";

describe("steady (buffering spinner hysteresis)", () => {
  it("ignores flapping shorter than the delays", () => {
    // seeking toggles every 100 ms for a second after a backward seek
    const flap: [number, boolean][] = Array.from({ length: 10 }, (_, i) => [i * 100, i % 2 === 0]);
    for (let t = 0; t <= 1000; t += 50) expect(steadyAt(flap, t)).toBe(false);
  });
  it("shows a real stall after 350 ms and hides it 400 ms after it ends", () => {
    const stall: [number, boolean][] = [[0, true], [2000, false]];
    expect(steadyAt(stall, 300)).toBe(false);
    expect(steadyAt(stall, 360)).toBe(true);
    expect(steadyAt(stall, 2300)).toBe(true);
    expect(steadyAt(stall, 2410)).toBe(false);
  });
});

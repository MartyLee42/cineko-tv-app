import { describe, expect, it } from "vitest";
import { pickDelay, STICKER_KINDS, stickerOf } from "./sticker";

describe("stickerOf", () => {
  it("is stable and in range", () => {
    const id = "3f2c9a1e-6b1d-4c55-9e0a-2a7b8c9d0e1f";
    expect(stickerOf(id)).toBe(stickerOf(id));
    for (let i = 0; i < 200; i++) {
      const v = stickerOf(`id-${i}`);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(STICKER_KINDS);
    }
  });
  it("spreads ids over every variant", () => {
    const seen = new Set(Array.from({ length: 60 }, (_, i) => stickerOf(`00000000-0000-0000-0000-0000000000${i}`)));
    expect(seen.size).toBe(STICKER_KINDS);
  });
});

describe("pickDelay", () => {
  const base = { pickMs: 220, calm: false, fast: false, hasCard: true };
  it("waits for the pick animation", () => expect(pickDelay(base)).toBe(220));
  it("opens at once without an animation, in calm mode, while scrolling fast or off a card", () => {
    expect(pickDelay({ ...base, pickMs: undefined })).toBe(0);
    expect(pickDelay({ ...base, calm: true })).toBe(0);
    expect(pickDelay({ ...base, fast: true })).toBe(0);
    expect(pickDelay({ ...base, hasCard: false })).toBe(0);
  });
  it("never holds navigation long", () => expect(pickDelay({ ...base, pickMs: 2000 })).toBe(300));
});

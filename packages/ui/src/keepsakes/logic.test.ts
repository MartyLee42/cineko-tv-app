import { describe, expect, it } from "vitest";
import { countKey, HOLES, knownStickers, paperFor, PAPERS, punchHoles, secretKey, stickerKeys, STICKERS, ticketDate, ticketSerial, tiltFor } from "./logic";
import { keepsakesEn } from "../locales/keepsakes.en";
import { keepsakesRu } from "../locales/keepsakes.ru";

describe("punchHoles", () => {
  it("punches one hole per rating point, from the first", () => {
    expect(punchHoles(7)).toEqual([true, true, true, true, true, true, true, false, false, false]);
    expect(punchHoles(10).every(Boolean)).toBe(true);
    expect(punchHoles(1).filter(Boolean)).toHaveLength(1);
  });
  it("leaves an unrated stub whole", () => {
    expect(punchHoles(null)).toHaveLength(HOLES);
    expect(punchHoles(null).some(Boolean)).toBe(false);
    expect(punchHoles(undefined).some(Boolean)).toBe(false);
  });
  it("clamps odd values", () => {
    expect(punchHoles(0).some(Boolean)).toBe(false);
    expect(punchHoles(14).filter(Boolean)).toHaveLength(10);
    expect(punchHoles(-3).some(Boolean)).toBe(false);
    expect(punchHoles(Number.NaN).some(Boolean)).toBe(false);
    expect(punchHoles(6.6).filter(Boolean)).toHaveLength(7);
  });
});

describe("stub text", () => {
  it("pads the serial", () => {
    expect(ticketSerial(42)).toBe("000042");
    expect(ticketSerial(1234567)).toBe("1234567");
  });
  it("prints numeric dates", () => {
    expect(ticketDate("2026-11-07")).toBe("07.11.2026");
    expect(ticketDate("bad")).toBe("bad");
  });
  it("pluralizes the count", () => {
    expect(countKey("ru", 1)).toBe("keepsakes.count_one");
    expect(countKey("ru", 3)).toBe("keepsakes.count_few");
    expect(countKey("ru", 12)).toBe("keepsakes.count_many");
    expect(countKey("en", 2)).toBe("keepsakes.count_many");
    expect(secretKey("ru", 0)).toBeNull();
    expect(secretKey("ru", 2)).toBe("keepsakes.secret_few");
  });
});

describe("the wall", () => {
  it("changes paper every three stubs and cycles", () => {
    expect([1, 2, 3].map(paperFor)).toEqual(["cream", "cream", "cream"]);
    expect(paperFor(4)).toBe("rose");
    expect(paperFor(1 + 3 * PAPERS.length)).toBe("cream");
  });
  it("tilts each stub a little, the same every time", () => {
    for (let n = 1; n < 200; n++) {
      const a = tiltFor(n);
      expect(a).toBe(tiltFor(n));
      expect(Math.abs(a)).toBeLessThanOrEqual(2);
    }
    expect(new Set([1, 2, 3, 4, 5].map(tiltFor)).size).toBeGreaterThan(2);
  });
});

describe("stickers", () => {
  it("skips ids without art", () => {
    const items = [{ id: "night_owl" }, { id: "future_one" }, { id: "marathon" }];
    expect(knownStickers(items).map((a) => a.id)).toEqual(["night_owl", "marathon"]);
  });
  it("has a name and description for every sticker", () => {
    for (const id of STICKERS) {
      const k = stickerKeys(id);
      expect(keepsakesRu[k.name as keyof typeof keepsakesRu]).toBeTruthy();
      expect(keepsakesEn[k.desc as keyof typeof keepsakesEn]).toBeTruthy();
    }
  });
});

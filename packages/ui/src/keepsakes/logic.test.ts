import { describe, expect, it } from "vitest";
import { countKey, HOLES, knownStickers, paperFor, PAPERS, progressLabel, progressShare, punchHoles, secretKey, stickerKeys, STICKERS, ticketDate, ticketSerial, tiltFor } from "./logic";
import { GLYPHS } from "./glyphs";
import { metalFor, METALS, PALETTES, SHAPES, SPECS, type StickerSpec } from "./stickers";
import { keepsakesEn } from "../locales/keepsakes.en";
import { keepsakesKk } from "../locales/keepsakes.kk";
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
      for (const m of [keepsakesRu, keepsakesEn, keepsakesKk] as Record<string, string>[]) {
        expect(m[k.name], `${id} name`).toBeTruthy();
        expect(m[k.desc], `${id} desc`).toBeTruthy();
      }
    }
  });
  it("has no strings for stickers that don't exist", () => {
    const ids = new Set<string>(STICKERS);
    for (const key of Object.keys(keepsakesRu)) {
      const m = /^keepsakes\.ach\.([a-z0-9_]+?)(\.desc)?$/.exec(key);
      if (m) expect(ids.has(m[1]!), key).toBe(true);
    }
  });
  it("keeps the first four (stored ids, hand-drawn art)", () => {
    expect(STICKERS.slice(0, 4)).toEqual(["marathon", "archaeologist", "polyglot", "night_owl"]);
    expect(STICKERS.length).toBeGreaterThanOrEqual(75);
  });
});

describe("sticker art", () => {
  const specs = Object.entries(SPECS) as [string, StickerSpec][];
  it("gives every parametric sticker a palette, a shape and a glyph or digits", () => {
    for (const [id, s] of specs) {
      if (s.bespoke) continue;
      expect(PALETTES[s.hue], id).toBeTruthy();
      expect(SHAPES[s.shape], id).toBeTruthy();
      expect(!!s.glyph !== !!s.text, `${id}: a glyph or text`).toBe(true);
      if (s.glyph) expect(GLYPHS[s.glyph](PALETTES[s.hue]), id).toBeTruthy();
      if (s.ribbon) expect(s.tier, `${id}: a ribbon needs a tier`).toBeGreaterThan(0);
    }
    expect(specs.filter(([, s]) => s.bespoke).map(([id]) => id)).toEqual(["marathon", "archaeologist", "polyglot", "night_owl"]);
  });
  it("climbs the metals within a ladder", () => {
    const ladders = new Map<string, { tier: number; goal: number }[]>();
    for (const [id, s] of specs) {
      const m = /^(.+)_(\d+)$/.exec(id);
      if (!m || !s.tier || !s.ribbon) continue;
      ladders.set(m[1]!, [...(ladders.get(m[1]!) ?? []), { tier: s.tier, goal: Number(m[2]) }]);
    }
    expect(ladders.get("films")?.map((x) => x.tier)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const [name, steps] of ladders) {
      for (let i = 1; i < steps.length; i++) {
        expect(steps[i]!.tier, name).toBeGreaterThan(steps[i - 1]!.tier);
        expect(steps[i]!.goal, name).toBeGreaterThan(steps[i - 1]!.goal);
      }
    }
    expect(metalFor(0)).toBe(METALS[0]);
    expect(metalFor(99)).toBe(METALS[METALS.length - 1]);
  });
  it("draws shapes inside the box", () => {
    for (const [name, paths] of Object.entries(SHAPES)) {
      for (const d of paths) {
        const nums = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
        expect(nums.length, name).toBeGreaterThan(6);
        for (const n of nums) expect(Number.isFinite(n) && n >= 0 && n <= 120, `${name}: ${n}`).toBe(true);
      }
    }
  });
});

describe("progress", () => {
  it("fills the bar", () => {
    expect(progressShare(37, 50)).toBeCloseTo(0.74);
    expect(progressShare(0, 50)).toBe(0);
    expect(progressShare(80, 50)).toBe(1);
    expect(progressShare(3, 0)).toBe(0);
    expect(progressShare(Number.NaN, 5)).toBe(0);
  });
  it("labels it", () => {
    expect(progressLabel(37, 50)).toBe("37 / 50");
    expect(progressLabel(740, 1000)).toBe("740 / 1\u2009000");
  });
  it("only keeps progress the client can draw", () => {
    expect(knownStickers([{ id: "films_50", have: 37, need: 50 }, { id: "films_9000", have: 1, need: 9000 }]).map((p) => p.id)).toEqual(["films_50"]);
  });
});

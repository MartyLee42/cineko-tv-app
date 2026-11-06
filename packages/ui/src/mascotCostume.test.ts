import { describe, expect, it } from "vitest";
import { costumePlan } from "./mascotCostume";
import { genreReaction } from "./genreReaction";
import { mascotEn } from "./locales/mascot.en";
import { mascotRu } from "./locales/mascot.ru";

describe("costumePlan", () => {
  it("dresses Cineko per design", () => {
    expect(costumePlan("deco", null, "idle")?.costume).toBe("tophat");
    expect(costumePlan("retro90", null, "idle")?.costume).toBe("pixelcat");
    expect(costumePlan("cyberpunk", null, "idle")?.costume).toBe("visor");
    expect(costumePlan("matrix", null, "idle")?.costume).toBe("sunglasses");
    expect(costumePlan("popart", null, "idle")?.costume).toBe("bubble");
  });

  it("no costume for the plain designs, Конструктивизм or before a design is applied", () => {
    for (const d of ["kinozal", "terminal", "projector", "wireframe", "retro80", "constructivism"] as const) expect(costumePlan(d, null, "idle")).toBeNull();
    expect(costumePlan(null, null, "idle")).toBeNull();
  });

  it("a seasonal hat wins over the top hat; face and corner items stay", () => {
    expect(costumePlan("deco", "santa", "idle")).toBeNull();
    expect(costumePlan("matrix", "witch", "idle")?.costume).toBe("sunglasses");
    expect(costumePlan("popart", "santa", "idle")?.costume).toBe("bubble");
  });

  it("head and face items only on stickers measured for them, drawn on the still sticker", () => {
    // No eyes measured (one ring eye): no sunglasses; the head is: a hat.
    expect(costumePlan("matrix", null, "loading")).toBeNull();
    expect(costumePlan("deco", null, "loading")?.head).toBeDefined();
    // Under the umbrella: no hat, but glasses.
    expect(costumePlan("deco", null, "rain")).toBeNull();
    expect(costumePlan("matrix", null, "rain")?.eyes).toHaveLength(2);
    // Not measured at all.
    expect(costumePlan("cyberpunk", null, "laptop")).toBeNull();
    expect(costumePlan("matrix", null, "idle")?.still).toBe(true);
    // Corner items keep the animated loop.
    expect(costumePlan("popart", null, "laptop")).toEqual({ costume: "bubble", still: false });
  });

  it("places the eyes inside the 120 box, left eye left of the right one", () => {
    for (const mood of ["idle", "happy", "popcorn", "surprised", "rain", "love", "sleepy"] as const) {
      const p = costumePlan("matrix", null, mood)!;
      const [l, r] = p.eyes!;
      for (const e of [l, r]) {
        expect(e.x).toBeGreaterThan(0);
        expect(e.x).toBeLessThan(120);
        expect(e.y).toBeGreaterThan(0);
        expect(e.y).toBeLessThan(120);
      }
      expect(l.x).toBeLessThan(r.x);
    }
  });
});

describe("genreReaction", () => {
  const g = (...ids: number[]) => ids.map((id) => ({ id }));
  it("horror > comedy > drama", () => {
    expect(genreReaction(g(18, 35, 27))?.kind).toBe("horror");
    expect(genreReaction(g(18, 35))?.kind).toBe("comedy");
    expect(genreReaction(g(18))).toMatchObject({ kind: "drama", mood: "rain" });
    expect(genreReaction(g(27))?.mood).toBe("surprised");
    expect(genreReaction(g(35))?.mood).toBe("happy");
  });
  it("nothing for other genres or none", () => {
    expect(genreReaction(g(28, 878))).toBeNull();
    expect(genreReaction([])).toBeNull();
    expect(genreReaction(undefined)).toBeNull();
  });
});

describe("mascot locale", () => {
  it("ru mirrors en", () => {
    expect(Object.keys(mascotRu).sort()).toEqual(Object.keys(mascotEn).sort());
  });
});

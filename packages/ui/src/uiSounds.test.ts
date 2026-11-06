import { describe, expect, it } from "vitest";
import { DESIGNS } from "./designs";
import { makeThrottle, recipeLength, uiSoundForKey, uiSoundRecipe, UI_SOUND_MAX, UI_TICK_EVERY_MS } from "./uiSounds";

describe("interface sounds", () => {
  it("every design has a short tick and click, the tick no longer than the click", () => {
    for (const d of DESIGNS) {
      const tick = uiSoundRecipe(d, "tick");
      const click = uiSoundRecipe(d, "click");
      expect(tick.tones.length + tick.noise.length, d).toBeGreaterThan(0);
      expect(click.tones.length + click.noise.length, d).toBeGreaterThan(0);
      expect(recipeLength(click), d).toBeLessThanOrEqual(UI_SOUND_MAX);
      expect(recipeLength(tick), d).toBeLessThanOrEqual(recipeLength(click));
    }
  });

  it("designs sound different: a Win95 click, a VHS clunk, terminal beeps (Matrix lower)", () => {
    const r90 = uiSoundRecipe("retro90", "click");
    expect(r90.tones[0]?.wave).toBe("square");
    expect(r90.noise.length).toBeGreaterThan(0);
    const vhs = uiSoundRecipe("retro80", "click");
    expect(vhs.tones[0]!.from).toBeLessThan(200); // low thud
    expect(vhs.noise.length).toBeGreaterThan(0);
    const term = uiSoundRecipe("terminal", "click").tones[0]!;
    const matrix = uiSoundRecipe("matrix", "click").tones[0]!;
    expect(term.wave).toBe("square");
    expect(matrix.from).toBeLessThan(term.from);
    expect(uiSoundRecipe("nonsense", "tick")).toEqual(uiSoundRecipe("kinozal", "tick"));
  });

  it("throttles key repeat to one tick per interval", () => {
    const gate = makeThrottle(UI_TICK_EVERY_MS);
    expect(gate(1000)).toBe(true);
    expect(gate(1030)).toBe(false);
    expect(gate(1000 + UI_TICK_EVERY_MS)).toBe(true);
    expect(gate(1000 + UI_TICK_EVERY_MS + 10)).toBe(false);
  });

  it("maps remote keys", () => {
    expect(uiSoundForKey("ArrowLeft")).toBe("tick");
    expect(uiSoundForKey("Enter")).toBe("click");
    expect(uiSoundForKey("a")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { gridMove, inviteDue, optionKey, sameSelection, toggleOption } from "./quizLogic";

describe("taste quiz logic", () => {
  // 10 chips, 4 per row (rows 0-3, 4-7, 8-9), 3 buttons (10, 11, 12).
  it("moves through the chip grid and down to the buttons", () => {
    expect(gridMove(0, 10, 4, 3, "right")).toBe(1);
    expect(gridMove(3, 10, 4, 3, "right")).toBe(3);
    expect(gridMove(9, 10, 4, 3, "right")).toBe(9);
    expect(gridMove(4, 10, 4, 3, "left")).toBe(4);
    expect(gridMove(1, 10, 4, 3, "down")).toBe(5);
    expect(gridMove(7, 10, 4, 3, "down")).toBe(9);
    expect(gridMove(8, 10, 4, 3, "down")).toBe(12);
    expect(gridMove(5, 10, 4, 3, "up")).toBe(1);
    expect(gridMove(1, 10, 4, 3, "up")).toBe(1);
    expect(gridMove(12, 10, 4, 3, "left")).toBe(11);
    expect(gridMove(10, 10, 4, 3, "left")).toBe(10);
    expect(gridMove(11, 10, 4, 3, "up")).toBe(8);
  });
  it("toggles options (single replaces)", () => {
    expect(toggleOption(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleOption(["a", "b"], "a", true)).toEqual(["b"]);
    expect(toggleOption(["a"], "b", false)).toEqual(["b"]);
    expect(toggleOption(["a"], "a", false)).toEqual([]);
  });
  it("labels and selections", () => {
    expect(optionKey("genres_dislike", "27")).toBe("quiz.g.27");
    expect(optionKey("mood", "dark")).toBe("quiz.o.mood.dark");
    expect(sameSelection(["b", "a"], ["a", "b"])).toBe(true);
    expect(sameSelection([], undefined)).toBe(true);
    expect(sameSelection(["a"], [])).toBe(false);
  });
  it("invites until finished, dismissed or postponed", () => {
    expect(inviteDue({ completed_at: null, dismissed_at: null }, false)).toBe(true);
    expect(inviteDue({ completed_at: "x", dismissed_at: null }, false)).toBe(false);
    expect(inviteDue({ completed_at: null, dismissed_at: "x" }, false)).toBe(false);
    expect(inviteDue({ completed_at: null, dismissed_at: null }, true)).toBe(false);
    expect(inviteDue(undefined, false)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { DISLIKE_REASONS, LIKE_REASONS, noteBody, noteEmpty, reasonChips, sideForRating, toggleReason } from "./notes";

describe("note helpers", () => {
  it("suggests chips by rating", () => {
    expect(sideForRating(3)).toBe("dislike");
    expect(sideForRating(5)).toBe("dislike");
    expect(sideForRating(6)).toBe("all");
    expect(sideForRating(8)).toBe("like");
    expect(sideForRating(null)).toBe("all");
    expect(reasonChips("like")).toEqual(LIKE_REASONS);
    expect(reasonChips("dislike", ["funny"])).toEqual([...DISLIKE_REASONS, "funny"]);
  });
  it("toggles and builds the body", () => {
    expect(toggleReason(["too_slow"], "too_slow")).toEqual([]);
    expect(toggleReason(["too_slow"], "funny")).toEqual(["too_slow", "funny"]);
    expect(noteBody("  meh  ", ["too_slow", "too_slow"])).toEqual({ text: "meh", reasons: ["too_slow"] });
    expect(noteEmpty({ text: " ", reasons: [] })).toBe(true);
    expect(noteEmpty(null)).toBe(true);
    expect(noteEmpty({ text: "", reasons: ["funny"] })).toBe(false);
  });
});

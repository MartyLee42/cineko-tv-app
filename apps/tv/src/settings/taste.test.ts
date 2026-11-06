import { describe, expect, it } from "vitest";
import { applyNoteKey, DEFAULT_MIN_VOTES, parseMinVotes, TASTE_NOTE_MAX, truncateNote } from "./taste";

describe("taste note on the TV", () => {
  it("types lower-case with sentence capitals", () => {
    let s = "";
    for (const c of "ЛЮБЛЮ") s = applyNoteKey(s, { type: "char", value: c });
    s = applyNoteKey(s, { type: "space" });
    s = applyNoteKey(s, { type: "space" });
    s = applyNoteKey(s, { type: "char", value: "Н" });
    expect(s).toBe("Люблю н");
    expect(applyNoteKey("Нуар. ", { type: "char", value: "D" })).toBe("Нуар. D");
    expect(applyNoteKey("Нуар", { type: "backspace" })).toBe("Нуа");
    expect(applyNoteKey("Нуар", { type: "clear" })).toBe("");
    expect(applyNoteKey("Нуар и ", { type: "char", value: "Q" }, true)).toBe("Нуар и Q");
  });
  it("stops at the limit", () => {
    const full = "я".repeat(TASTE_NOTE_MAX);
    expect(applyNoteKey(full, { type: "char", value: "Я" })).toBe(full);
    expect(applyNoteKey(full, { type: "space" })).toBe(full);
  });
  it("truncates for the row", () => {
    expect(truncateNote("  короткая\n заметка ")).toBe("короткая заметка");
    const long = truncateNote("слово ".repeat(30), 20);
    expect([...long].length).toBeLessThanOrEqual(20);
    expect(long.endsWith("…")).toBe(true);
  });
  it("parses min_votes", () => {
    expect(parseMinVotes(5000)).toBe(5000);
    expect(parseMinVotes(7)).toBe(DEFAULT_MIN_VOTES);
  });
});

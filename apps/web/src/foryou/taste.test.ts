import { describe, expect, it } from "vitest";
import { balanceLow, DEFAULT_MIN_VOTES, formatBalance, regenState, regenTime, noteDirty, noteLength, noteTooLong, parseMinVotes, TASTE_NOTE_MAX } from "./taste";

describe("taste note helpers", () => {
  it("counts the trimmed note in code points", () => {
    expect(noteLength("  люблю нуар  ")).toBe(10);
    expect(noteLength("🎬🎬")).toBe(2);
    expect(noteTooLong("я".repeat(TASTE_NOTE_MAX))).toBe(false);
    expect(noteTooLong(" " + "я".repeat(TASTE_NOTE_MAX) + " ")).toBe(false);
    expect(noteTooLong("я".repeat(TASTE_NOTE_MAX + 1))).toBe(true);
  });
  it("detects changes ignoring outer spaces", () => {
    expect(noteDirty("нуар", " нуар ")).toBe(false);
    expect(noteDirty(undefined, "")).toBe(false);
    expect(noteDirty("нуар", "нуар и вестерны")).toBe(true);
  });
  it("parses min_votes choices", () => {
    expect(parseMinVotes("1000")).toBe(1000);
    expect(parseMinVotes(0)).toBe(0);
    expect(parseMinVotes("7")).toBe(DEFAULT_MIN_VOTES);
  });
});

describe("deepseek balance", () => {
  it("formats and flags a low balance", () => {
    expect(formatBalance({ available: true, currency: "USD", total: 9.53 }, "en")).toBe("$9.53");
    expect(balanceLow({ available: true, currency: "USD", total: 9.53 })).toBe(false);
    expect(balanceLow({ available: true, currency: "USD", total: 0.99 })).toBe(true);
    expect(balanceLow({ available: false, currency: "USD", total: 50 })).toBe(true);
    expect(formatBalance({ available: true, currency: "??", total: 2 }, "en")).toBe("2.00 ??");
  });
});

describe("regenerate button", () => {
  const base = { available: true, running: false, unlimited: false, ai_enabled: true, next_available_at: "2026-10-29T21:00:00Z" };
  it("maps the status", () => {
    expect(regenState(undefined)).toBe("hidden");
    expect(regenState({ ...base, ai_enabled: false })).toBe("hidden");
    expect(regenState(base)).toBe("available");
    expect(regenState({ ...base, available: false, running: true })).toBe("running");
    expect(regenState({ ...base, available: false })).toBe("used");
  });
  it("formats the next time", () => {
    expect(regenTime("2026-10-29T21:00:00Z", "ru")).toMatch(/^\d\d:\d\d$/);
  });
});

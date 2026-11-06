import { describe, expect, it } from "vitest";
import { factsSourceKey, formatQuote, formatSpeaker, isFactHidden, revealFact, showQuotesButton, stepIndex, stripQuoteMarks } from "./trivia";

describe("formatQuote", () => {
  it("wraps in the language's quotation marks", () => {
    expect(formatQuote("Я вернусь", "ru")).toBe("«Я вернусь»");
    expect(formatQuote("I'll be back", "en")).toBe("“I'll be back”");
  });
  it("does not double marks the source already has", () => {
    expect(formatQuote("«Я вернусь»", "ru")).toBe("«Я вернусь»");
    expect(formatQuote("“I'll be back.”", "ru")).toBe("«I'll be back.»");
    expect(formatQuote(' "Hi" ', "en")).toBe("“Hi”");
  });
  it("keeps inner quotes and apostrophes", () => {
    expect(stripQuoteMarks("He said «no» twice")).toBe("He said «no» twice");
    expect(stripQuoteMarks("'Tis")).toBe("'Tis");
  });
});

describe("formatSpeaker", () => {
  it("adds an em dash, without doubling one", () => {
    expect(formatSpeaker("Терминатор")).toBe("— Терминатор");
    expect(formatSpeaker("— Терминатор")).toBe("— Терминатор");
    expect(formatSpeaker("- Neo")).toBe("— Neo");
  });
  it("is null without a speaker", () => {
    expect(formatSpeaker(null)).toBeNull();
    expect(formatSpeaker("  ")).toBeNull();
  });
});

describe("showQuotesButton", () => {
  const data = (n: number) => ({ items: Array.from({ length: n }, () => ({ text: "x", speaker: null })), source: null, source_url: null, lang: "ru" as const });
  it("shows while loading and on error, hides when empty", () => {
    expect(showQuotesButton({ isPending: true, isError: false })).toBe(true);
    expect(showQuotesButton({ isPending: false, isError: true })).toBe(true);
    expect(showQuotesButton({ isPending: false, isError: false, data: data(0) })).toBe(false);
    expect(showQuotesButton({ isPending: false, isError: false, data: data(2) })).toBe(true);
  });
});

describe("stepIndex", () => {
  it("clamps or wraps", () => {
    expect(stepIndex(0, -1, 3)).toBe(0);
    expect(stepIndex(2, 1, 3)).toBe(2);
    expect(stepIndex(2, 1, 3, true)).toBe(0);
    expect(stepIndex(0, -1, 3, true)).toBe(2);
    expect(stepIndex(5, 1, 0, true)).toBe(0);
  });
});

describe("spoilers", () => {
  const facts = [
    { text: "a", kind: "fact" as const, spoiler: false },
    { text: "b", kind: "blooper" as const, spoiler: true },
    { text: "c", kind: "fact" as const, spoiler: true },
  ];
  it("hides spoilers until revealed one by one", () => {
    let r: Set<number> = new Set();
    expect(facts.map((f, i) => isFactHidden(f, i, r))).toEqual([false, true, true]);
    r = revealFact(r, 1);
    expect(facts.map((f, i) => isFactHidden(f, i, r))).toEqual([false, false, true]);
  });
  it("does not mutate the previous set", () => {
    const r = new Set<number>();
    revealFact(r, 2);
    expect(r.size).toBe(0);
  });
});

describe("factsSourceKey", () => {
  it("names Kinopoisk and the AI", () => {
    expect(factsSourceKey("kinopoisk")).toBe("trivia.source.kinopoisk");
    expect(factsSourceKey("ai")).toBe("trivia.source.ai");
    expect(factsSourceKey(null)).toBeNull();
  });
});

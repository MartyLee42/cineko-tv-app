import { describe, expect, it } from "vitest";
import { ASK_ERROR, ASK_INCLUDE_WATCHED_DEFAULT, ASK_MAX, askErrorKind, cleanPrompt, refinePrompt } from "./aiAsk";

describe("ask core", () => {
  it("cleans and bounds the prompt", () => {
    expect(cleanPrompt("  hi ")).toBeNull();
    expect(cleanPrompt("  что-нибудь \n лёгкое  ")).toBe("что-нибудь лёгкое");
    expect([...cleanPrompt("я".repeat(600))!].length).toBe(ASK_MAX);
  });

  it("refines the previous prompt with a follow-up", () => {
    expect(refinePrompt("Комедия на вечер.", "Без романтики")).toBe("Комедия на вечер, без романтики");
    expect(refinePrompt("комедия, без романтики", "Без романтики")).toBe("комедия, без романтики");
    expect(refinePrompt("", "Покороче")).toBe("Покороче");
    expect(refinePrompt("  лёгкое  на вечер ", "  ")).toBe("лёгкое на вечер");
    // Refining twice keeps every constraint.
    expect(refinePrompt(refinePrompt("Сериал на выходные", "Покороче"), "А из 90-х?")).toBe("Сериал на выходные, покороче, а из 90-х?");
  });

  it("keeps a refined prompt within the limit, dropping the oldest words", () => {
    const long = Array.from({ length: 120 }, (_, i) => `слово${i}`).join(" ");
    const r = refinePrompt(long, "Без ужасов");
    expect([...r].length).toBeLessThanOrEqual(ASK_MAX);
    expect(r.endsWith(", без ужасов")).toBe(true);
    expect(r.startsWith("слово")).toBe(true); // cut at a word boundary
    expect(cleanPrompt(r)).toBe(r);
    expect([...refinePrompt("x", "я".repeat(600))].length).toBe(ASK_MAX);
  });

  it("maps errors the same for ApiError-like objects", () => {
    expect(askErrorKind({ status: 503, code: "ai_disabled" })).toBe("disabled");
    expect(askErrorKind({ status: 429, code: "ask_limit" })).toBe("limit");
    expect(askErrorKind({ status: 429, code: "ai_budget" })).toBe("budget");
    expect(askErrorKind({ status: 502, code: "ai_failed" })).toBe("failed");
    expect(askErrorKind({ status: 429, code: "rate_limited" })).toBe("limit");
    expect(askErrorKind({ status: 500, code: "internal" })).toBe("generic");
    expect(askErrorKind(new Error("offline"))).toBe("generic");
    expect(askErrorKind(null)).toBe("generic");
    expect(ASK_ERROR.failed.retry).toBe(true);
    expect(ASK_ERROR.limit.retry).toBe(false);
  });

  it("leaves watched titles out by default", () => {
    expect(ASK_INCLUDE_WATCHED_DEFAULT).toBe(false);
  });
});

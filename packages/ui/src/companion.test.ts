import { describe, expect, it } from "vitest";
import { afterScopeLabel, chatCanSend, companionErrorKey, companionRetryable, showAfterButton, showRecapButton, stepTab } from "./companion";

const status = (ai: boolean, recap: boolean, after: boolean) => ({
  ai_enabled: ai,
  recap: { available: recap },
  after_credits: { available: after, scope: after ? "movie" : "", season: null },
});

describe("companion", () => {
  it("shows the buttons only with AI on and when available", () => {
    expect(showRecapButton(undefined)).toBe(false);
    expect(showRecapButton(status(true, true, false))).toBe(true);
    expect(showRecapButton(status(false, true, false))).toBe(false);
    expect(showAfterButton(status(true, false, true))).toBe(true);
    expect(showAfterButton(status(true, true, false))).toBe(false);
  });

  it("labels the spoiler scope", () => {
    expect(afterScopeLabel("season", 2)).toEqual({ key: "companion.scope.season", vars: { n: 2 } });
    expect(afterScopeLabel("series", 5).key).toBe("companion.scope.series");
    expect(afterScopeLabel("movie", null).key).toBe("companion.scope.movie");
  });

  it("maps API errors", () => {
    expect(companionErrorKey("companion_limit")).toBe("companion.error.limit");
    expect(companionErrorKey("ai_budget")).toBe("companion.error.budget");
    expect(companionErrorKey("ai_failed")).toBe("companion.error.failed");
    expect(companionErrorKey(undefined)).toBe("companion.error.failed");
    expect(companionRetryable("network_error")).toBe(true);
    expect(companionRetryable("companion_limit")).toBe(false);
  });

  it("checks chat input", () => {
    expect(chatCanSend("  а  ", 3)).toBe(false);
    expect(chatCanSend("Почему?", 3)).toBe(true);
    expect(chatCanSend("Почему?", 0)).toBe(false);
    expect(chatCanSend("я".repeat(301), 3)).toBe(false);
  });

  it("steps tabs without wrapping", () => {
    expect(stepTab("ending", -1)).toBe("ending");
    expect(stepTab("ending", 1)).toBe("significance");
    expect(stepTab("chat", 1)).toBe("chat");
  });
});

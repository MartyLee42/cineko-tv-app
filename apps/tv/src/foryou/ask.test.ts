import { describe, expect, it } from "vitest";
import { ApiError } from "@martytv/contracts";
import { translate } from "@martytv/ui";
import { ASK_EXAMPLES, askErrorKind, askInbox, askValid, displayUrl, exampleLabel, examplePrompt, parseAskEvent, phoneAskUrl, sentenceCase, tailText, type AskResult } from "./askLogic";

const err = (status: number, code: string) => new ApiError(status, { error: { code, message: "x" } });

describe("ask helpers", () => {
  it("builds the phone link for this TV and profile", () => {
    expect(phoneAskUrl("http://tv.local:8080/", "dev-1", "p 1")).toBe("http://tv.local:8080/ask?device=dev-1&profile=p%201");
    expect(phoneAskUrl("https://x", "d", null)).toBe("https://x/ask?device=d");
    expect(displayUrl("https://x.example/ask?device=d")).toBe("x.example/ask");
  });

  it("maps API errors to screen states", () => {
    expect(askErrorKind(err(503, "ai_disabled"))).toBe("disabled");
    expect(askErrorKind(err(429, "ask_limit"))).toBe("limit");
    expect(askErrorKind(err(429, "ai_budget"))).toBe("budget");
    expect(askErrorKind(err(429, "rate_limited"))).toBe("limit");
    expect(askErrorKind(err(502, "ai_failed"))).toBe("failed");
    expect(askErrorKind(err(500, "internal"))).toBe("generic");
    expect(askErrorKind(new Error("offline"))).toBe("generic");
  });

  it("turns keyboard capitals into a sentence and validates length", () => {
    expect(sentenceCase("  ЛЁГКОЕ   НА ВЕЧЕР ")).toBe("Лёгкое на вечер");
    expect(sentenceCase("")).toBe("");
    expect(askValid("ab")).toBe(false);
    expect(askValid(" abc ")).toBe(true);
    expect(askValid("x".repeat(501))).toBe(false);
    expect(tailText("abcdefgh", 5)).toBe("…efgh");
    expect(tailText("abc", 5)).toBe("abc");
  });

  it("every example has a label and a prompt", () => {
    for (const e of ASK_EXAMPLES) {
      for (const loc of ["en", "ru"] as const) {
        expect(translate(loc, exampleLabel(e))).not.toBe(exampleLabel(e));
        expect(translate(loc, examplePrompt(e))).not.toBe(examplePrompt(e));
      }
    }
  });

  it("parses foryou.ask events and delivers them to the screen or keeps one", () => {
    expect(parseAskEvent(null)).toBeNull();
    expect(parseAskEvent({ answer: "a" })).toBeNull();
    const r = parseAskEvent({ id: "1", prompt: "p", answer: "a", items: [] })!;
    expect(r.followups).toEqual([]);
    askInbox.push(r);
    expect(askInbox.take()).toBe(r);
    expect(askInbox.take()).toBeNull();
    const got: AskResult[] = [];
    const off = askInbox.subscribe((x) => got.push(x));
    askInbox.push(r);
    off();
    expect(got).toEqual([r]);
    expect(askInbox.take()).toBeNull();
  });
});

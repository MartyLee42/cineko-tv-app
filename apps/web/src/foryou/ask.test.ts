import { describe, expect, it } from "vitest";
import { askBody, askErrorKind, askTarget, cleanPrompt, examplePrompt, formOf, newAskForm, refinePrompt, ASK_EXAMPLES, ASK_ERROR } from "./ask";

const PID = "11111111-2222-3333-4444-555555555555";
const DEV = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("ask helpers", () => {
  it("cleans and bounds the prompt", () => {
    expect(cleanPrompt("  hi ")).toBeNull();
    expect(cleanPrompt("  что-нибудь \n лёгкое  ")).toBe("что-нибудь лёгкое");
    expect([...cleanPrompt("я".repeat(600))!].length).toBe(500);
  });

  it("builds the request body", () => {
    const form = { prompt: " Лёгкое на вечер ", kind: "movie" as const, includeWatched: true };
    expect(askBody(form, PID, "ru")).toEqual({ profile_id: PID, prompt: "Лёгкое на вечер", lang: "ru", kind: "movie", include_watched: true });
    expect(askBody(form, PID, "en", DEV)?.device_id).toBe(DEV);
    expect(askBody({ ...form, prompt: "a" }, PID, "en")).toBeNull();
  });

  it("maps error codes to states", () => {
    expect(askErrorKind({ status: 503, code: "ai_disabled" })).toBe("disabled");
    expect(askErrorKind({ status: 429, code: "ask_limit" })).toBe("limit");
    expect(askErrorKind({ status: 429, code: "ai_budget" })).toBe("budget");
    expect(askErrorKind({ status: 502, code: "ai_failed" })).toBe("failed");
    expect(askErrorKind({ status: 429, code: "rate_limited" })).toBe("limit");
    expect(askErrorKind({ status: 0, code: "network_error" })).toBe("generic");
    expect(askErrorKind(null)).toBe("generic");
    expect(ASK_ERROR.failed.retry).toBe(true);
    expect(ASK_ERROR.disabled.retry).toBe(false);
  });

  it("reads the phone → TV params", () => {
    expect(askTarget(`?device=${DEV.toUpperCase()}&profile=${PID}`, [PID])).toEqual({ deviceId: DEV, profileId: PID });
    expect(askTarget(`?device=nope&profile=${PID}`, [])).toEqual({ deviceId: null, profileId: null });
    expect(askTarget("", [PID])).toEqual({ deviceId: null, profileId: null });
  });

  it("refines with follow-ups and keeps a past ask's settings", () => {
    expect(refinePrompt("Комедия на вечер.", "Без романтики")).toBe("Комедия на вечер, без романтики");
    expect(newAskForm()).toEqual({ prompt: "", kind: "any", includeWatched: false });
    expect(formOf({ prompt: "p", kind: "series", include_watched: true })).toEqual({ prompt: "p", kind: "series", includeWatched: true });
    expect(formOf({ prompt: "p", kind: "", include_watched: false }).kind).toBe("any");
  });

  it("has a prompt key per example", () => {
    expect(ASK_EXAMPLES.map(examplePrompt)).toContain("ask.example.light.prompt");
  });
});

import { describe, expect, it } from "vitest";
import { chatActions } from "./companionLogic";

describe("after-credits chat actions", () => {
  it("offers suggestions, then asking, then a new chat", () => {
    expect(chatActions(undefined)).toEqual([]);
    expect(chatActions({ followups: [], remaining: 6, messages: [] }).map((a) => a.kind)).toEqual(["ask"]);
    const full = chatActions({ followups: ["Почему волчок?"], remaining: 2, messages: [{ role: "user", text: "q" }, { role: "assistant", text: "a" }] });
    expect(full).toEqual([{ kind: "followup", text: "Почему волчок?" }, { kind: "ask" }, { kind: "new" }]);
  });

  it("only restarts a chat that is out of questions", () => {
    expect(chatActions({ followups: ["x"], remaining: 0, messages: [{ role: "user", text: "q" }] }).map((a) => a.kind)).toEqual(["new"]);
  });
});

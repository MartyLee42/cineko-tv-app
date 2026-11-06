import { beforeEach, describe, expect, it } from "vitest";
import { slowHintPref } from "./slowHint";

describe("slowHintPref", () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  });
  it("is off until turned on", () => {
    expect(slowHintPref.get()).toBe(false);
    slowHintPref.set(true);
    expect(slowHintPref.get()).toBe(true);
    slowHintPref.set(false);
    expect(slowHintPref.get()).toBe(false);
  });
});

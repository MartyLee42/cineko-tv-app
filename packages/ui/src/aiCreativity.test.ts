import { beforeEach, describe, expect, it, vi } from "vitest";
import { readAICreativity, writeAICreativity } from "./aiCreativity";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});

describe("AI creativity", () => {
  beforeEach(() => mem.clear());
  it("defaults to normal and remembers the choice", () => {
    expect(readAICreativity()).toBe("normal");
    writeAICreativity("bold");
    expect(readAICreativity()).toBe("bold");
    expect(mem.get("martytv.ai_creativity")).toBe("bold");
    writeAICreativity("normal");
    expect(mem.has("martytv.ai_creativity")).toBe(false);
  });
  it("ignores junk", () => {
    mem.set("martytv.ai_creativity", "wild");
    expect(readAICreativity()).toBe("normal");
  });
});

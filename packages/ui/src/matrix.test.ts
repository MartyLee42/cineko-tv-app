import { beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPillSeen, requestPill, resolvePill, resetPillForTests, shouldAskPill, usePillRequest, wakeUpTail } from "./matrix";

// Node test env: an in-memory localStorage.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

describe("matrix pill", () => {
  beforeEach(() => {
    localStorage.clear();
    resetPillForTests();
  });

  it("asks only the first time, only when switching to Matrix", () => {
    expect(shouldAskPill("matrix", "kinozal", false)).toBe(true);
    expect(shouldAskPill("matrix", "kinozal", true)).toBe(false);
    expect(shouldAskPill("matrix", "matrix", false)).toBe(false);
    expect(shouldAskPill("deco", "kinozal", false)).toBe(false);
  });

  it("blue reverts to the previous design, red keeps it; both are remembered", () => {
    const revert = vi.fn();
    requestPill({ previous: "deco", revert });
    resolvePill("red");
    expect(revert).not.toHaveBeenCalled();
    expect(matrixPillSeen()).toBe(true);
    localStorage.clear();
    requestPill({ previous: "deco", revert });
    resolvePill("blue");
    expect(revert).toHaveBeenCalledOnce();
    expect(matrixPillSeen()).toBe(true);
    expect(typeof usePillRequest).toBe("function");
  });

  it("the wake-up tail changes by day, not by hour", () => {
    const tails = ["a", "b", "c"];
    const morning = wakeUpTail(tails, new Date(2026, 10, 6, 8));
    expect(wakeUpTail(tails, new Date(2026, 10, 6, 22))).toBe(morning);
    expect(wakeUpTail(tails, new Date(2026, 10, 7, 8))).not.toBe(morning);
  });
});

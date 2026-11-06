import { describe, expect, it } from "vitest";
import { gridNeighbor, gridWindow, nearEnd, rowWindow, trackOffset, windowRange } from "./virtual";
import { applyKey, LAYOUTS, normalizeQuery, physicalKey, type KeyAction } from "./keyboard";
import { cardKey, linearNext, uniqueById } from "./focusKeys";
import { initialStack, openSection, pop, push } from "./nav";

describe("virtual window", () => {
  it("renders a window around the focused index", () => {
    expect(windowRange(0, 100, 4, 8)).toEqual([0, 9]);
    expect(windowRange(50, 100, 4, 8)).toEqual([46, 59]);
    expect(windowRange(99, 100, 4, 8)).toEqual([95, 100]);
    expect(windowRange(3, 0, 4, 8)).toEqual([0, 0]);
    expect(windowRange(200, 10, 2, 2)).toEqual([7, 10]);
  });

  it("keeps the focused card at the left edge until the end of the row", () => {
    // 20 cards, pitch 300, width 280, viewport 1700
    expect(trackOffset(0, 20, 300, 280, 1700)).toBe(0);
    expect(trackOffset(3, 20, 300, 280, 1700)).toBe(900);
    // content = 19*300+280 = 5980 → max offset 4280
    expect(trackOffset(19, 20, 300, 280, 1700)).toBe(4280);
    // Everything fits: never scrolls.
    expect(trackOffset(4, 5, 300, 280, 1700)).toBe(0);
  });

  it("moves in a grid and lets focus escape at the edges", () => {
    // 10 items, 4 cols: rows [0..3] [4..7] [8,9]
    expect(gridNeighbor(0, 10, 4, "left")).toBeNull();
    expect(gridNeighbor(0, 10, 4, "up")).toBeNull();
    expect(gridNeighbor(3, 10, 4, "right")).toBeNull();
    expect(gridNeighbor(5, 10, 4, "down")).toBe(9);
    expect(gridNeighbor(7, 10, 4, "down")).toBe(9);
    expect(gridNeighbor(9, 10, 4, "right")).toBeNull();
    expect(gridNeighbor(9, 10, 4, "down")).toBeNull();
    expect(gridNeighbor(9, 10, 4, "up")).toBe(5);
  });

  it("virtualizes grids by rows", () => {
    expect(gridWindow(0, 100, 6, 2, 3)).toEqual([0, 24]);
    expect(gridWindow(40, 100, 6, 2, 3)).toEqual([24, 60]);
    expect(gridWindow(99, 100, 6, 2, 3)).toEqual([84, 100]);
  });

  it("detects the end of loaded content", () => {
    expect(nearEnd(10, 40, 12)).toBe(false);
    expect(nearEnd(28, 40, 12)).toBe(true);
    expect(nearEnd(0, 0, 12)).toBe(false);
  });
});

describe("on-screen keyboard", () => {
  const type = (text: string, ...keys: KeyAction[]) => keys.reduce(applyKey, text);
  const chars = (s: string) => s.split("").map((value): KeyAction => ({ type: "char", value }));

  it("types, deletes and clears", () => {
    expect(type("", ...chars("MATRIX"))).toBe("MATRIX");
    expect(type("MATRIX", { type: "backspace" })).toBe("MATRI");
    expect(type("MATRIX", { type: "clear" })).toBe("");
    expect(type("", { type: "backspace" })).toBe("");
  });

  it("avoids leading and double spaces", () => {
    expect(type("", { type: "space" })).toBe("");
    expect(type("THE", { type: "space" }, { type: "space" }, ...chars("ONE"))).toBe("THE ONE");
  });

  it("has full EN and RU layouts with digits", () => {
    expect(LAYOUTS.en).toHaveLength(36);
    expect(LAYOUTS.ru).toHaveLength(43);
    expect(LAYOUTS.ru).toContain("Ё");
    expect(type("", ...chars("МАТРИЦА"))).toBe("МАТРИЦА");
  });

  it("maps physical keys, including Cyrillic", () => {
    expect(physicalKey("m")).toEqual({ type: "char", value: "M" });
    expect(physicalKey("ж")).toEqual({ type: "char", value: "Ж" });
    expect(physicalKey(" ")).toEqual({ type: "space" });
    expect(physicalKey("Backspace")).toEqual({ type: "backspace" });
    expect(physicalKey("ArrowLeft")).toBeNull();
    expect(physicalKey("Enter")).toBeNull();
    expect(physicalKey("c", true)).toBeNull();
  });

  it("normalizes the query", () => {
    expect(normalizeQuery("  THE   MATRIX ")).toBe("THE MATRIX");
  });
});

describe("focus keys", () => {
  it("builds stable keys", () => {
    expect(cardKey("row-trending", "abc")).toBe("row-trending-abc");
  });

  it("walks linear containers", () => {
    const keys = ["a", "b", "c"];
    expect(linearNext(keys, "a", "right", "horizontal")).toBe("b");
    expect(linearNext(keys, "a", "left", "horizontal")).toBeNull();
    expect(linearNext(keys, "c", "right", "horizontal")).toBeNull();
    expect(linearNext(keys, "b", "up", "horizontal")).toBeNull();
    expect(linearNext(keys, "b", "up", "vertical")).toBe("a");
    expect(linearNext(keys, "x", "down", "vertical")).toBeNull();
  });

  it("dedupes paged items", () => {
    expect(uniqueById([{ id: "1" }, { id: "2" }, { id: "1" }]).map((x) => x.id)).toEqual(["1", "2"]);
  });
});

describe("screen stack", () => {
  it("pushes and pops, never below Home", () => {
    let s = initialStack();
    s = push(s, { name: "details", id: "m1" });
    expect(s.map((e) => e.route.name)).toEqual(["home", "details"]);
    s = pop(s);
    expect(s.map((e) => e.route.name)).toEqual(["home"]);
    expect(pop(s)).toBe(s);
  });

  it("opens menu sections on top of Home and keeps Home's memory", () => {
    const s0 = initialStack();
    s0[0]!.mem.set("focusKey", "row-trending-1");
    const s1 = openSection(push(s0, { name: "details", id: "m1" }), { name: "browse", kind: "movie" });
    expect(s1.map((e) => e.route.name)).toEqual(["home", "browse"]);
    expect(s1[0]!.mem.focusKey).toBe("row-trending-1");
    expect(openSection(s1, { name: "browse", kind: "movie" })).toBe(s1);
    expect(openSection(s1, { name: "home" })).toHaveLength(1);
  });
});

describe("rowWindow", () => {
  // 20 cards, pitch 232, a 1720 px row: ~7.4 cards fit on screen.
  const pitch = 232;
  const off = (i: number) => trackOffset(i, 20, pitch, 204, 1720);
  it("at the end of a row renders every card on screen, not just 4 before the focus", () => {
    const [a, b] = rowWindow(19, 20, 4, 8, off(19), pitch, 1720);
    expect(b).toBe(20);
    // The first visible card (offset / pitch) is rendered.
    expect(a).toBeLessThanOrEqual(Math.floor(off(19) / pitch));
    expect(b - a).toBeGreaterThanOrEqual(8);
  });
  it("in the middle keeps the usual window", () => {
    expect(rowWindow(10, 20, 4, 8, off(10), pitch, 1720)).toEqual([6, 19]);
  });
});

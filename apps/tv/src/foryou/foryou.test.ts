import { describe, expect, it } from "vitest";
import { historyLines, historyView, type HistoryLike } from "@martytv/ui";
import { cycle, lineWindow, listLayout, listScroll } from "./layout";
import { KINOZAL_MENU, PROJECTOR_ICONS, PROJECTOR_TEXT, RAIL_PITCH, railIndicatorTop, TERMINAL_MENU } from "../design/menuOrder";

const h = (id: string, at: string): HistoryLike => ({
  media: { id, kind: "movie", title: id, original_title: id, me: { rating: null } },
  progress: { completed: true, completed_at: at, updated_at: at, episode_id: null },
});

// 2 in October, 1 in September, 3 in August.
const items = [
  h("a", "2026-10-20T00:00:00Z"),
  h("b", "2026-10-02T00:00:00Z"),
  h("c", "2026-09-10T00:00:00Z"),
  h("d", "2026-08-30T00:00:00Z"),
  h("e", "2026-08-20T00:00:00Z"),
  h("f", "2026-08-01T00:00:00Z"),
];
const lines = historyLines(historyView(items, { kind: "all", q: "" }));
const G = { month: 90, item: 120 };

describe("history list layout", () => {
  it("stacks month headers and items", () => {
    const l = listLayout(lines, G);
    expect(l.tops).toEqual([0, 90, 210, 330, 420, 540, 630, 750, 870]);
    expect(l.items).toEqual([1, 2, 4, 6, 7, 8]);
    expect(l.height).toBe(990);
  });

  it("renders a window around the focused item, with the month header above its first line", () => {
    const l = listLayout(lines, G);
    expect(lineWindow(l, 0, 1, 1)).toEqual([0, 3]);
    // Focus on "e" (item 4): items d..f, plus the August header before d.
    expect(lineWindow(l, 4, 1, 1)).toEqual([5, 9]);
    // Focus on "c": items b..d (lines 2..6); b's header isn't directly above, so the window starts at b.
    expect(lineWindow(l, 2, 1, 1)).toEqual([2, 7]);
    expect(lineWindow(listLayout([], G), 0, 2, 2)).toEqual([0, 0]);
  });

  it("scrolls the focused item to the anchor, never above the top", () => {
    const l = listLayout(lines, G);
    expect(listScroll(l, 0, 200)).toBe(0);
    expect(listScroll(l, 5, 200)).toBe(870 - 200);
    expect(listScroll(l, 99, 0)).toBe(870);
  });

  it("cycles toggle values", () => {
    expect(cycle(["movie", "series", "any"], "any")).toBe("movie");
    expect(cycle([null, 6, 7], null)).toBe(6);
  });
});

describe("menus", () => {
  it("every design offers Explore, Surprise, Ask AI and History once", () => {
    for (const m of [KINOZAL_MENU, TERMINAL_MENU, [...PROJECTOR_TEXT, ...PROJECTOR_ICONS]]) {
      for (const id of ["home", "explore", "surprise", "ask", "history", "search", "movies", "series", "new", "mine", "messages"] as const) {
        expect(m.filter((x) => x === id)).toHaveLength(1);
      }
    }
  });

  it("places Кинозал's active marker next to its item and fits above settings", () => {
    expect(railIndicatorTop("search")).toBe(145);
    expect(railIndicatorTop("history")).toBe(134 + KINOZAL_MENU.indexOf("history") * RAIL_PITCH + 11);
    expect(railIndicatorTop("settings")).toBeNull();
    expect(railIndicatorTop(null)).toBeNull();
    // Last top item ends above the bottom group (settings at 1080 − 36 − 62 − 72).
    expect(134 + KINOZAL_MENU.length * RAIL_PITCH).toBeLessThan(1080 - 36 - 62 - 72);
  });
});

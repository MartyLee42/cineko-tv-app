import { describe, expect, it } from "vitest";
import { airedKey, daysSinceAir, pluralFormRu, withoutSeries } from "@martytv/media-types";
import { KINOZAL_MENU, PROJECTOR_ICONS, PROJECTOR_TEXT, TERMINAL_MENU } from "../design/menuOrder";

describe("new episodes", () => {
  const now = new Date(2026, 9, 30, 21, 15); // 30 Oct 2026, local evening
  it("counts days since the air date in local time", () => {
    expect(daysSinceAir("2026-10-30", now)).toBe(0);
    expect(daysSinceAir("2026-10-29", now)).toBe(1);
    expect(daysSinceAir("2026-10-25", now)).toBe(5);
    expect(daysSinceAir("2026-09-30", now)).toBe(30);
    expect(daysSinceAir("2026-11-02", now)).toBe(0); // future dates never go negative
    expect(daysSinceAir(null, now)).toBeNull();
    expect(daysSinceAir("garbage", now)).toBeNull();
  });
  it("picks today / yesterday / N days", () => {
    expect(airedKey(0)).toEqual({ key: "newep.aired_today", n: 0 });
    expect(airedKey(1)).toEqual({ key: "newep.aired_yesterday", n: 1 });
    expect(airedKey(5)).toEqual({ key: "newep.aired_days", n: 5 });
    expect(airedKey(null)).toBeNull();
    expect([1, 2, 5, 11, 21, 22, 25, 101].map(pluralFormRu)).toEqual([0, 1, 2, 2, 0, 1, 2, 0]);
  });
  it("has its own tab in every layout (after Series; Проектор: the first icon tab)", () => {
    for (const m of [KINOZAL_MENU, TERMINAL_MENU]) expect(m[m.indexOf("series") + 1]).toBe("new");
    expect(PROJECTOR_TEXT).not.toContain("new");
    expect(PROJECTOR_ICONS[0]).toBe("new");
  });
});

describe("muting a series", () => {
  const item = (media: string, seen: boolean) => ({ media: { id: media }, seen });
  const list = { items: [item("a", false), item("b", false), item("a", true), item("a", false)], unseen: 7 };
  it("drops the series' items and its unseen ones from the count", () => {
    const out = withoutSeries(list, "a");
    expect(out.items.map((x) => x.media.id)).toEqual(["b"]);
    expect(out.unseen).toBe(5);
    expect(list.items).toHaveLength(4); // not mutated
  });
  it("leaves other lists alone and never goes below zero", () => {
    expect(withoutSeries(list, "zz")).toBe(list);
    expect(withoutSeries({ items: [item("a", false), item("a", false)], unseen: 1 }, "a").unseen).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { dayStatuses, dayWindow } from "./logic";

const at = (h: number, m = 0) => new Date(2026, 10, 1, h, m).toISOString();
const p = (a: number, b: number) => ({ start: at(a), stop: at(b) });

describe("«Программа на сегодня»", () => {
  it("covers the local day", () => {
    const { from, to } = dayWindow(new Date(2026, 10, 1, 15, 30).getTime());
    expect([from.getHours(), from.getDate(), to.getDate(), to.getHours()]).toEqual([0, 1, 2, 0]);
  });
  it("marks past / now / later and focuses the current programme", () => {
    const items = [p(6, 8), p(8, 10), p(10, 12), p(12, 14)];
    const r = dayStatuses(items, new Date(2026, 10, 1, 10, 30).getTime());
    expect(r.status).toEqual(["past", "past", "now", "later"]);
    expect(r.focus).toBe(2);
  });
  it("focuses the next one in a gap, the last one after the day", () => {
    const items = [p(6, 8), p(9, 10)];
    expect(dayStatuses(items, new Date(2026, 10, 1, 8, 30).getTime()).focus).toBe(1);
    expect(dayStatuses(items, new Date(2026, 10, 1, 23, 0).getTime()).focus).toBe(1);
    expect(dayStatuses([], Date.now()).focus).toBe(0);
  });
});

describe("programWindow (live programme panel)", () => {
  it("keeps the selection a few rows from the top, clamped to the list", async () => {
    const { programWindow } = await import("./logic");
    expect(programWindow(0, 20)).toBe(0);
    expect(programWindow(10, 20)).toBe(7);
    expect(programWindow(19, 20)).toBe(11);
    expect(programWindow(2, 4)).toBe(0);
  });
});

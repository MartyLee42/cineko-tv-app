import { describe, expect, it } from "vitest";
import { orderChooserTvs, preselectTarget, skipChooser, type ChooserTv } from "./chooser";

const tv = (id: string, online: boolean, playing = false): ChooserTv => ({ id, name: id, online, playing });

describe("orderChooserTvs", () => {
  it("puts the TV showing the title first, then the last used, online before offline", () => {
    const list = [tv("b", false), tv("c", true), tv("d", true), tv("a", true, true)];
    expect(orderChooserTvs(list, "d").map((d) => d.id)).toEqual(["a", "d", "c", "b"]);
  });
  it("an offline TV still «playing» (stale state) goes with the offline ones", () => {
    expect(orderChooserTvs([tv("x", false, true), tv("y", true)], null).map((d) => d.id)).toEqual(["y", "x"]);
  });
});

describe("preselectTarget", () => {
  const tvs = [tv("a", true), tv("b", true, true), tv("c", false)];
  it("repeats «here»", () => expect(preselectTarget(tvs, "a", "here")).toBe("here"));
  it("repeats the last used TV when online", () => expect(preselectTarget(tvs, "a", "tv")).toBe("tv:a"));
  it("falls back to the TV showing the title, then the first online", () => {
    expect(preselectTarget(tvs, "c", "tv")).toBe("tv:b");
    expect(preselectTarget([tv("a", true), tv("d", true)], null, null)).toBe("tv:a");
  });
  it("no TV online → here", () => expect(preselectTarget([tv("c", false)], "c", "tv")).toBe("here"));
});

describe("skipChooser", () => {
  it("plays here only when there is surely no TV", () => {
    expect(skipChooser([], false)).toBe(true);
    expect(skipChooser(undefined, false)).toBe(false);
    expect(skipChooser([], true)).toBe(false);
    expect(skipChooser([tv("a", false)], false)).toBe(false);
  });
});

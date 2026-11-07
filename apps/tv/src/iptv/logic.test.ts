import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IptvChannel } from "@martytv/contracts";
import { buildChips, channelByNumber, channelChips, channelInitials, digitKey, epgProgress, filterGroup, minutesLeft, NumberInput, offlineLabel, stepChannel } from "./logic";

const ch = (id: string, number: number, o: Partial<IptvChannel> = {}): IptvChannel => ({
  id,
  number,
  name: id,
  logo_url: null,
  group_id: "news",
  group: "News",
  playlist_id: "p",
  favorite: false,
  hidden: false,
  offline: false,
  format: "hls",
  has_epg: false,
  now: null,
  next: null,
  ...o,
});

describe("epg progress", () => {
  const p = { start: "2026-10-29T10:00:00Z", stop: "2026-10-29T11:00:00Z" };
  it("is the aired fraction, clamped", () => {
    expect(epgProgress(p, Date.parse("2026-10-29T10:15:00Z"))).toBeCloseTo(0.25);
    expect(epgProgress(p, Date.parse("2026-10-29T09:00:00Z"))).toBe(0);
    expect(epgProgress(p, Date.parse("2026-10-29T12:00:00Z"))).toBe(1);
  });
  it("is null without a usable programme", () => {
    expect(epgProgress(null, 0)).toBeNull();
    expect(epgProgress({ start: "x", stop: "y" }, 0)).toBeNull();
    expect(epgProgress({ start: p.stop, stop: p.start }, 0)).toBeNull();
  });
  it("counts minutes left", () => {
    expect(minutesLeft(p, Date.parse("2026-10-29T10:15:30Z"))).toBe(45);
    expect(minutesLeft(p, Date.parse("2026-10-29T12:00:00Z"))).toBe(0);
  });
});

describe("grouping", () => {
  const items = [ch("a", 1, { favorite: true }), ch("b", 2, { group_id: "sports" }), ch("c", 3, { group_id: "g:local", group: "Local" })];
  it("builds chips: all, favorites, then groups (known ids get a key)", () => {
    const chips = buildChips(
      [
        { id: "news", name: "News", count: 1 },
        { id: "g:local", name: "Местные", count: 1 },
      ],
      3,
      1,
    );
    expect(chips.map((c) => c.id)).toEqual(["all", "favorites", "news", "g:local"]);
    expect(chips[2]!.key).toBe("iptv.group.news");
    expect(chips[3]!.key).toBeNull();
    expect(chips[3]!.name).toBe("Местные");
    expect(buildChips([], 3, 0).map((c) => c.id)).toEqual(["all"]);
  });
  it("filters by chip", () => {
    expect(filterGroup(items, "all")).toHaveLength(3);
    expect(filterGroup(items, "favorites").map((c) => c.id)).toEqual(["a"]);
    expect(filterGroup(items, "sports").map((c) => c.id)).toEqual(["b"]);
  });
  it("keeps broken channels behind «Нерабочие»", () => {
    const list = [...items, ch("d", 4, { offline: true, health: "dead", group_id: "sports" }), ch("e", 5, { offline: true, favorite: true })];
    const groups = [
      { id: "news", name: "News", count: 2 },
      { id: "sports", name: "Sports", count: 2 },
      { id: "g:local", name: "Local", count: 1 },
    ];
    const chips = channelChips(groups, list);
    expect(chips.map((c) => [c.id, c.count])).toEqual([
      ["all", 3],
      ["favorites", 1],
      ["news", 1],
      ["sports", 1],
      ["g:local", 1],
      ["broken", 2],
    ]);
    expect(chips[5]!.key).toBe("iptvplay.broken");
    expect(filterGroup(list, "all").map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(filterGroup(list, "favorites").map((c) => c.id)).toEqual(["a"]);
    expect(filterGroup(list, "broken").map((c) => c.id)).toEqual(["d", "e"]);
    expect(channelChips(groups, items).map((c) => c.id)).not.toContain("broken");
    expect(offlineLabel({ health: "geo" })).toBe("iptvplay.health.geo");
    expect(offlineLabel({ health: null })).toBe("iptv.offline");
  });
});

describe("channel switching", () => {
  const list = [ch("a", 1), ch("b", 2), ch("c", 5)];
  it("steps with wrap-around", () => {
    expect(stepChannel(list, "a", 1)!.id).toBe("b");
    expect(stepChannel(list, "c", 1)!.id).toBe("a");
    expect(stepChannel(list, "a", -1)!.id).toBe("c");
    expect(stepChannel(list, "zz", 1)!.id).toBe("a");
    expect(stepChannel([], "a", 1)).toBeNull();
  });
  it("jumps to a number, else the nearest higher, else the last", () => {
    expect(channelByNumber(list, 2)!.id).toBe("b");
    expect(channelByNumber(list, 3)!.id).toBe("c");
    expect(channelByNumber(list, 99)!.id).toBe("c");
    expect(channelByNumber(list, 0)).toBeNull();
  });
});

describe("number input", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("collects digits and commits after a pause", () => {
    const commits: number[] = [];
    const shown: string[] = [];
    const n = new NumberInput((x) => commits.push(x), (d) => shown.push(d));
    n.push(1);
    n.push(2);
    expect(n.value).toBe("12");
    vi.advanceTimersByTime(1400);
    expect(commits).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(commits).toEqual([12]);
    expect(n.value).toBe("");
    expect(shown).toEqual(["1", "12", ""]);
  });
  it("commits at once on 4 digits or OK; ignores a leading 0; Back cancels", () => {
    const commits: number[] = [];
    const n = new NumberInput((x) => commits.push(x), () => undefined);
    n.push(0);
    expect(n.value).toBe("");
    for (const d of [1, 0, 2, 4]) n.push(d);
    expect(commits).toEqual([1024]);
    n.push(7);
    expect(n.commit()).toBe(true);
    expect(commits).toEqual([1024, 7]);
    n.push(3);
    expect(n.cancel()).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(commits).toEqual([1024, 7]);
    expect(n.commit()).toBe(false);
  });
  it("reads digits from keys and remote key codes", () => {
    expect(digitKey({ key: "7", keyCode: 55 })).toBe(7);
    expect(digitKey({ key: "Unidentified", keyCode: 52 })).toBe(4);
    expect(digitKey({ key: "", keyCode: 99 })).toBe(3);
    expect(digitKey({ key: "a", keyCode: 65 })).toBeNull();
  });
});

describe("menus", () => {
  it("puts «ТВ» right after «Главная» in every design", async () => {
    const { KINOZAL_MENU, TERMINAL_MENU, PROJECTOR_TEXT } = await import("../design/menuOrder");
    for (const m of [KINOZAL_MENU, TERMINAL_MENU, PROJECTOR_TEXT]) expect(m[m.indexOf("home") + 1]).toBe("tv");
  });
});

describe("channelInitials", () => {
  it("takes two letters", () => {
    expect(channelInitials("Первый канал")).toBe("ПК");
    expect(channelInitials("2x2")).toBe("2X");
    expect(channelInitials("Матч! ТВ")).toBe("МТ");
    expect(channelInitials("—")).toBe("TV");
  });
});

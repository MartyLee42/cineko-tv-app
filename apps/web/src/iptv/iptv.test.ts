import { describe, expect, it } from "vitest";
import type { IptvChannel } from "@martytv/contracts";
import {
  blockSpan,
  buildChips,
  channelByNumber,
  channelChips,
  coverage,
  dayOffset,
  filterChannels,
  floorTo,
  formatLag,
  guideWindow,
  initials,
  liveLag,
  minutesLeft,
  neighbour,
  onAir,
  programmeProgress,
  timeTicks,
  togglePlaylist,
  typeDigit,
} from "./logic";

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-10-29T18:00:00Z");
const MIN = 60_000;

function ch(id: string, number: number, name: string, o: Partial<IptvChannel> = {}): IptvChannel {
  return {
    id, number, name, custom_number: null, logo_url: null, group_id: "general", group: "General", playlist_id: "p",
    favorite: false, hidden: false, offline: false, format: "hls", has_epg: false, now: null, next: null, ...o,
  };
}

describe("programme progress", () => {
  const p = { start: iso(T0), stop: iso(T0 + 60 * MIN) };
  it("is 0…1 and clamped", () => {
    expect(programmeProgress(p, T0 + 15 * MIN)).toBeCloseTo(0.25);
    expect(programmeProgress(p, T0 - MIN)).toBe(0);
    expect(programmeProgress(p, T0 + 2 * 60 * MIN)).toBe(1);
    expect(programmeProgress(null, T0)).toBe(0);
    expect(programmeProgress({ start: iso(T0), stop: iso(T0) }, T0)).toBe(0);
  });
  it("counts minutes left (rounded up, never negative)", () => {
    expect(minutesLeft(p, T0 + 15 * MIN + 30_000)).toBe(45);
    expect(minutesLeft(p, T0 + 61 * MIN)).toBe(0);
  });
  it("finds the programme on air", () => {
    const items = [p, { start: iso(T0 + 60 * MIN), stop: iso(T0 + 90 * MIN) }];
    expect(onAir(items, T0 + 70 * MIN)).toBe(items[1]);
    expect(onAir(items, T0 + 95 * MIN)).toBeNull();
  });
});

describe("chips and filtering", () => {
  it("orders Все, Избранное, known groups, playlist groups by size, «Другое» last", () => {
    const chips = buildChips(
      [
        { id: "other", name: "Undefined", count: 9 },
        { id: "g:regional", name: "Региональные", count: 3 },
        { id: "sports", name: "Sports", count: 4 },
        { id: "news", name: "News", count: 2 },
        { id: "g:hd", name: "HD", count: 7 },
        { id: "kids", name: "Kids", count: 0 },
      ],
      25,
      2,
    );
    expect(chips.map((c) => c.id)).toEqual(["all", "favorites", "news", "sports", "g:hd", "g:regional", "other"]);
    expect(chips[0]!.count).toBe(25);
    expect(chips.find((c) => c.id === "g:hd")!.known).toBe(false);
    expect(chips.find((c) => c.id === "news")!.known).toBe(true);
  });

  const list = [
    ch("a", 1, "Первый канал", { group_id: "general" }),
    ch("b", 2, "Россия 24", { group_id: "news", favorite: true }),
    ch("c", 12, "Ёлки ТВ", { group_id: "kids" }),
  ];
  it("filters by group and favorites", () => {
    expect(filterChannels(list, "all", "").map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(filterChannels(list, "news", "").map((c) => c.id)).toEqual(["b"]);
    expect(filterChannels(list, "favorites", "").map((c) => c.id)).toEqual(["b"]);
  });
  it("searches names (case/ё-insensitive) and number prefixes", () => {
    expect(filterChannels(list, "all", "елки").map((c) => c.id)).toEqual(["c"]);
    expect(filterChannels(list, "all", "РОССИЯ").map((c) => c.id)).toEqual(["b"]);
    expect(filterChannels(list, "all", "1").map((c) => c.id)).toEqual(["a", "c"]);
    expect(filterChannels(list, "all", "12").map((c) => c.id)).toEqual(["c"]);
  });
});

describe("guide grid", () => {
  it("floors to the step and opens the window 30 min before now", () => {
    const now = new Date(2026, 9, 29, 18, 47, 12).getTime();
    expect(new Date(floorTo(now, 30)).getMinutes()).toBe(30);
    const w = guideWindow(now, 3);
    expect(new Date(w.from).getHours()).toBe(18);
    expect(new Date(w.from).getMinutes()).toBe(0);
    expect(w.to - w.from).toBe(3 * 3_600_000);
    expect(guideWindow(now, 3, 1).from).toBe(w.to);
  });
  it("lays out ticks and clips programme blocks", () => {
    const from = T0;
    const to = T0 + 2 * 60 * MIN;
    expect(timeTicks(from, to, 30)).toHaveLength(4);
    expect(blockSpan({ start: iso(T0 - 30 * MIN), stop: iso(T0 + 30 * MIN) }, from, to)).toEqual({ left: 0, width: 25 });
    expect(blockSpan({ start: iso(T0 + 60 * MIN), stop: iso(T0 + 3 * 60 * MIN) }, from, to)).toEqual({ left: 50, width: 50 });
    expect(blockSpan({ start: iso(T0 + 3 * 60 * MIN), stop: iso(T0 + 4 * 60 * MIN) }, from, to)).toBeNull();
  });
  it("labels days relative to now", () => {
    const now = new Date(2026, 9, 29, 23, 0).getTime();
    expect(dayOffset(new Date(2026, 9, 30, 0, 30).toISOString(), now)).toBe(1);
    expect(dayOffset(new Date(2026, 9, 29, 1, 0).toISOString(), now)).toBe(0);
    expect(dayOffset(new Date(2026, 9, 28, 22, 0).toISOString(), now)).toBe(-1);
  });
});

describe("player helpers", () => {
  const list = [ch("a", 1, "A"), ch("b", 2, "B"), ch("c", 7, "C")];
  it("zaps with wrap-around", () => {
    expect(neighbour(list, "b", 1)!.id).toBe("c");
    expect(neighbour(list, "c", 1)!.id).toBe("a");
    expect(neighbour(list, "a", -1)!.id).toBe("c");
    expect(neighbour(list, "zzz", 1)!.id).toBe("a");
    expect(neighbour([], "a", 1)).toBeNull();
  });
  it("collects typed channel numbers", () => {
    expect(typeDigit("", "0")).toBe("");
    expect(typeDigit("", "7")).toBe("7");
    expect(typeDigit("12", "3")).toBe("123");
    expect(typeDigit("1234", "5")).toBe("2345");
    expect(typeDigit("1", "x")).toBe("1");
    expect(channelByNumber(list, "7")!.id).toBe("c");
    expect(channelByNumber(list, "3")).toBeNull();
    expect(channelByNumber(list, "")).toBeNull();
  });
  it("measures the distance to the live edge", () => {
    expect(liveLag(90, 100)).toBe(10);
    expect(liveLag(110, 100)).toBe(0);
    expect(liveLag(10, null)).toBe(0);
    expect(formatLag(65)).toBe("1:05");
    expect(formatLag(3725)).toBe("1:02:05");
  });
  it("makes initials for missing logos", () => {
    expect(initials("Россия 24")).toBe("Р2");
    expect(initials("НТВ")).toBe("НТ");
    expect(initials("—")).toBe("TV");
  });
});

describe("settings and admin helpers", () => {
  it("toggles playlists, collapsing to all", () => {
    expect(togglePlaylist("all", ["p1", "p2"], "p2", false)).toEqual(["p1"]);
    expect(togglePlaylist(["p1"], ["p1", "p2"], "p2", true)).toBe("all");
    expect(togglePlaylist(["p1", "gone"], ["p1", "p2", "p3"], "p3", true)).toEqual(["p1", "p3"]);
  });
  it("computes EPG coverage", () => {
    expect(coverage({ channels: 200, with_programmes: 150 })).toBe(75);
    expect(coverage({ channels: 0, with_programmes: 0 })).toBe(0);
  });
});

describe("broken channels («Нерабочие»)", () => {
  const items = [
    ch("a", 1, "Первый", { group_id: "news" }),
    ch("b", 2, "Россия", { group_id: "news", offline: true, health: "dead" }),
    ch("c", 3, "Спорт", { group_id: "sports", offline: true, health: "geo" }),
  ];
  const groups = [
    { id: "news", name: "News", count: 2 },
    { id: "sports", name: "Sports", count: 1 },
  ];
  it("get their own last chip; the rest are recounted", () => {
    expect(channelChips(groups, items).map((c) => [c.id, c.count])).toEqual([
      ["all", 1],
      ["favorites", 0],
      ["news", 1],
      ["broken", 2],
    ]);
  });
  it("show only under it, or when searched for", () => {
    expect(filterChannels(items, "all", "").map((c) => c.id)).toEqual(["a"]);
    expect(filterChannels(items, "broken", "").map((c) => c.id)).toEqual(["b", "c"]);
    expect(filterChannels(items, "all", "росс").map((c) => c.id)).toEqual(["b"]);
    expect(filterChannels(items, "sports", "росс")).toEqual([]);
  });
});

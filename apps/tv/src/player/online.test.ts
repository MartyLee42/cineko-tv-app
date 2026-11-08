import { describe, expect, it } from "vitest";
import type { OnlineList, OnlineVariant } from "./data";
import { defaultEpisode, defaultVariant, groupBySource, isOnlineRelease, nextOnlineVariant, pickerOnlineGroup, pickerRows, playableEpisodes, qualityChoices, rowScroll, watchOnlineItems } from "./online";

const v = (id: string, o: Partial<OnlineVariant> = {}): OnlineVariant => ({
  id,
  provider: { id: "cdnvideohub", name: "CDNVideoHub", kind: "online" },
  voice: "Дубляж",
  voiceover: { kind: "dub", studio: null, language: "ru" },
  title: null,
  max_quality: 1080,
  qualities: [1080, 720, 480],
  format: "mp4",
  subtitle_langs: [],
  season: null,
  episode: null,
  episodes: [],
  preferred: false,
  score: 0.5,
  ...o,
});
const collaps = { id: "collaps", name: "Collaps", kind: "online" as const };
const anime = { id: "anilibria", name: "AniLiberty", kind: "anime" as const };

const list = (items: OnlineVariant[], providers: OnlineList["providers"] = []): OnlineList => ({ items, providers, searched_at: "2026-10-29T00:00:00Z", cached: false });

describe("watchOnlineItems", () => {
  it("keeps only online (non-anime) variants", () => {
    expect(watchOnlineItems(list([v("a", { provider: anime }), v("b")])).map((x) => x.id)).toEqual(["b"]);
    expect(watchOnlineItems(undefined)).toEqual([]);
  });
});

describe("groupBySource", () => {
  it("groups by provider in first-seen order with the preferred voice first", () => {
    const g = groupBySource([v("c1", { provider: collaps, format: "hls" }), v("v1"), v("c2", { provider: collaps, preferred: true, format: "hls" })]);
    expect(g.map((x) => x.id)).toEqual(["collaps", "cdnvideohub"]);
    expect(g[0]!.items.map((x) => x.id)).toEqual(["c2", "c1"]);
  });
});

describe("defaultVariant", () => {
  const top = v("c", { provider: collaps, format: "hls", preferred: true });
  const mp4 = v("m", { voice: "Дубляж" });
  const other = v("o", { voice: "НТВ", voiceover: { kind: null, studio: "НТВ", language: "ru" } });
  it("keeps the server's pick with native HLS", () => {
    expect(defaultVariant([top, other, mp4], "native")?.id).toBe("c");
  });
  it("prefers an MP4 of the same voice without native HLS", () => {
    expect(defaultVariant([top, other, mp4], "hlsjs")?.id).toBe("m");
    expect(defaultVariant([top, other], "hlsjs")?.id).toBe("c");
  });
  it("takes any MP4 when HLS can't play", () => {
    expect(defaultVariant([top, other], "none")?.id).toBe("o");
    expect(defaultVariant([], "none")).toBeNull();
  });
});

describe("qualities and episodes", () => {
  it("offers Auto plus the qualities when there is a choice", () => {
    expect(qualityChoices(v("a", { qualities: [720, 2160, 1080] }))).toEqual([null, 2160, 1080, 720]);
    expect(qualityChoices(v("a", { qualities: [720] }))).toEqual([]);
    expect(qualityChoices(null)).toEqual([]);
  });
  it("lists episodes the variant and the catalog both have", () => {
    expect(playableEpisodes(v("a", { episodes: [3, 1, 2, 9] }), [1, 2, 3, 4])).toEqual([1, 2, 3]);
    expect(playableEpisodes(v("a", { episode: 4 }), [1, 2, 3, 4])).toEqual([4]);
    expect(playableEpisodes(v("a"), [2, 1])).toEqual([1, 2]);
  });
  it("starts at the wanted episode, else the next one, else the first", () => {
    expect(defaultEpisode([1, 2, 3], 2)).toBe(2);
    expect(defaultEpisode([1, 3, 5], 4)).toBe(5);
    expect(defaultEpisode([1, 3], 9)).toBe(1);
    expect(defaultEpisode([], 1)).toBeNull();
  });
});

describe("layout", () => {
  it("builds rows: voices per source, quality, episodes, play", () => {
    expect(pickerRows(2, true, true).map((r) => r.kind)).toEqual(["voice", "voice", "quality", "episode", "play"]);
    expect(pickerRows(1, false, false).map((r) => r.kind)).toEqual(["voice", "play"]);
  });
  it("scrolls a chip row only as needed", () => {
    expect(rowScroll(100, 200, 1000, 0)).toBe(0);
    expect(rowScroll(900, 200, 1000, 0)).toBe(140);
    expect(rowScroll(20, 200, 1000, 300)).toBe(0);
  });
});

describe("pickerOnlineGroup", () => {
  it("merges online and anime variants and names the kinds", () => {
    const g = pickerOnlineGroup(
      list([v("a", { provider: anime }), v("b")], [{ id: "collaps", name: "Collaps", kind: "online", status: "timeout", count: 0, error: "timed out", cached: false }]),
    );
    expect(g.items.map((x) => x.id)).toEqual(["a", "b"]);
    expect(g.kinds).toEqual(["online", "anime"]);
    expect(g.failed.map((p) => p.id)).toEqual(["collaps"]);
    expect(pickerOnlineGroup(list([v("a", { provider: anime })])).kinds).toEqual(["anime"]);
    expect(pickerOnlineGroup(undefined).show).toBe(false);
  });
});

describe("next episode of an online source", () => {
  const rel = (id: string, provider: { id: string; name: string; kind: "online" | "anime" | "torrent" } | undefined, studio: string | null) => ({
    id,
    provider: provider as never,
    voiceovers: studio ? [{ kind: null, studio, language: "ru" }] : [],
  });
  it("tells online releases from torrents", () => {
    expect(isOnlineRelease(rel("oabc", collaps, "LostFilm"))).toBe(true);
    expect(isOnlineRelease(rel("oabc", anime, "AniLiberty"))).toBe(true);
    expect(isOnlineRelease(rel("3f2a…", { id: "prowlarr", name: "Prowlarr", kind: "torrent" }, null))).toBe(false);
    // An older server (no provider on online releases): the "o" id says it.
    expect(isOnlineRelease(rel("o123", undefined, null))).toBe(true);
    expect(isOnlineRelease(rel("9c1e", undefined, null))).toBe(false);
    expect(isOnlineRelease(null)).toBe(false);
  });
  it("keeps the same source and voice", () => {
    const items = [v("a", { preferred: true, voice: "Дубляж" }), v("b", { provider: collaps, voice: "LostFilm" }), v("c", { voice: "LostFilm" })];
    expect(nextOnlineVariant(items, rel("oprev", collaps, "LostFilm"), "native")?.id).toBe("b");
  });
  it("then the same voice on another source, then the same source, then the server's pick", () => {
    const items = [v("a", { preferred: true, voice: "Дубляж" }), v("c", { voice: "LostFilm" }), v("d", { provider: collaps, voice: "Кубик в кубе" })];
    expect(nextOnlineVariant(items, rel("oprev", { id: "kodik", name: "Kodik", kind: "online" }, "LostFilm"), "native")?.id).toBe("c");
    expect(nextOnlineVariant(items, rel("oprev", collaps, "HDrezka"), "native")?.id).toBe("d");
    expect(nextOnlineVariant(items, rel("oprev", { id: "kodik", name: "Kodik", kind: "online" }, "HDrezka"), "native")?.id).toBe("a");
  });
  it("prefers MP4 where HLS can't play; none online → null (torrents)", () => {
    const items = [v("h", { provider: collaps, voice: "LostFilm", format: "hls", preferred: true }), v("m", { provider: collaps, voice: "LostFilm", format: "mp4" })];
    expect(nextOnlineVariant(items, rel("oprev", collaps, "LostFilm"), "none")?.id).toBe("m");
    expect(nextOnlineVariant([], rel("oprev", collaps, "LostFilm"), "native")).toBeNull();
  });
});

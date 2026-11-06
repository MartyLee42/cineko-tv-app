import { describe, expect, it } from "vitest";
import type { Release } from "@martytv/contracts";
import {
  audioLabel,
  clockText,
  filledSegments,
  indexTag,
  pluralRu,
  posterBadge,
  ratingList,
  remainingClock,
  rulerMarks,
  runtimeClock,
  splitTitle,
  summarizeRelease,
  tickerItems,
  tickerSeconds,
  torrState,
} from "./format";

const release = (p: Partial<Release> = {}): Release => ({
  id: "r1", title: "Dune.Part.Two.2024.2160p.UHD.BluRay.HDR10.Atmos.Dub", indexer: "RuTracker", size_bytes: 61.4 * 1024 ** 3, seeders: 312, leechers: 1,
  published_at: null, info_hash: null, resolution: "2160p", video_codec: "hevc", hdr: "hdr10", audio_codecs: ["truehd"], languages: ["ru"],
  voiceovers: [{ kind: "dub", studio: null, language: "ru" }], release_group: null, source_quality: "bluray", year: 2024, seasons: [], episodes: [],
  is_season_pack: false, confidence: 1, score: 1, reasons: [], warnings: [], ...p,
});

describe("splitTitle", () => {
  it("splits on the first colon", () => {
    expect(splitTitle("Дюна: Часть вторая")).toEqual({ main: "Дюна", sub: "Часть вторая" });
    expect(splitTitle("Mission: Impossible: Dead Reckoning")).toEqual({ main: "Mission", sub: "Impossible: Dead Reckoning" });
  });
  it("keeps titles without a usable colon whole", () => {
    expect(splitTitle("Сёгун")).toEqual({ main: "Сёгун", sub: null });
    expect(splitTitle("Re:")).toEqual({ main: "Re:", sub: null });
    expect(splitTitle(":Zero")).toEqual({ main: ":Zero", sub: null });
  });
});

describe("clocks and tags", () => {
  it("formats the clock, index tags and remaining time", () => {
    expect(clockText(new Date(2026, 9, 29, 9, 5))).toBe("09:05");
    expect(indexTag(3)).toBe("03");
    expect(indexTag(12)).toBe("12");
    expect(remainingClock(1624)).toBe("27:04");
    expect(remainingClock(4000)).toBe("1:06:40");
    expect(remainingClock(null)).toBeNull();
    expect(runtimeClock(166)).toBe("2:46");
    expect(runtimeClock(45)).toBe("0:45");
    expect(runtimeClock(null)).toBeNull();
  });
  it("fills segments without lying about started/finished", () => {
    expect(filledSegments(null, 40)).toBe(0);
    expect(filledSegments(0.001, 40)).toBe(1);
    expect(filledSegments(0.5, 40)).toBe(20);
    expect(filledSegments(0.999, 40)).toBe(39);
    expect(filledSegments(1, 40)).toBe(40);
  });
  it("adds the current progress to the ruler", () => {
    expect(rulerMarks(null).map((m) => m.label)).toEqual(["00", "25", "50", "75", "99"]);
    const r = rulerMarks(54);
    expect(r.map((m) => m.label)).toEqual(["00", "25", "54", "75", "99"]);
    expect(r.find((m) => m.current)?.label).toBe("54");
    expect(rulerMarks(25).filter((m) => m.current).map((m) => m.label)).toEqual(["25"]);
  });
});

describe("ratings", () => {
  it("lists known ratings, primary first", () => {
    expect(ratingList({ rating: 8.24, kp_rating: 8.5, imdb_rating: 8.7 })).toEqual([
      { source: "kp", value: "8.5" },
      { source: "imdb", value: "8.7" },
      { source: "tmdb", value: "8.2" },
    ]);
    expect(ratingList({ rating: 8.2, kp_rating: 8.5, imdb_rating: 8.7 }, "imdb")[0]).toEqual({ source: "imdb", value: "8.7" });
    expect(ratingList({ rating: 7, kp_rating: null })).toEqual([{ source: "tmdb", value: "7.0" }]);
    expect(ratingList({ rating: null })).toEqual([]);
  });
  it("shows the poster badge only when known and enabled", () => {
    expect(posterBadge({ rating: 8.24, kp_rating: 7.66 }, "kp")).toEqual({ text: "7.7", tone: "good", source: "kp" });
    // Unknown Kinopoisk rating falls back to TMDB.
    expect(posterBadge({ rating: 5.5, kp_rating: null }, "kp")).toEqual({ text: "5.5", tone: "mid", source: "tmdb" });
    expect(posterBadge({ rating: 4.1 }, "tmdb")).toEqual({ text: "4.1", tone: "bad", source: "tmdb" });
    expect(posterBadge({ rating: 8 }, "off")).toBeNull();
    expect(posterBadge({ rating: null, kp_rating: null }, "kp")).toBeNull();
    expect(posterBadge({ rating: 0 }, "tmdb")).toBeNull();
  });
});

describe("releases", () => {
  it("summarizes the auto-selected release", () => {
    const s = summarizeRelease(release(), "ru");
    expect(s).toMatchObject({ quality: "2160p", badge: "4K", hdr: "HDR10", voice: "dub", audio: "Atmos", seeders: 312, tracker: "RuTracker" });
    expect(s.size).toBe("61,4 ГБ");
    expect(summarizeRelease(release({ resolution: "480p", hdr: null, voiceovers: [] })).quality).toBe("SD");
    expect(summarizeRelease(release({ voiceovers: [{ kind: "mvo", studio: "LostFilm", language: "ru" }] }))).toMatchObject({ voice: "mvo", studio: "LostFilm" });
  });
  it("reads the audio layout from the title", () => {
    expect(audioLabel({ title: "Movie.1080p.DD5.1.mkv", audio_codecs: ["ac3"] })).toBe("5.1");
    expect(audioLabel({ title: "Movie 7.1 TrueHD", audio_codecs: ["truehd"] })).toBe("7.1");
    expect(audioLabel({ title: "Movie.2024.WEB-DL", audio_codecs: ["eac3"] })).toBe("E-AC3");
    expect(audioLabel({ title: "Movie.2024.15.1080p", audio_codecs: [] })).toBeNull();
  });
});

describe("status", () => {
  const labels = {
    online: "online",
    offline: "offline",
    torrserver: (ms: number | null) => `TorrServer ${ms ?? "?"} ms`,
    torrserverDown: "TorrServer offline",
    prowlarrDown: "Prowlarr offline",
    streams: (n: number) => `${n} streams now`,
    profile: (n: string) => `profile: ${n}`,
    unread: (n: number) => `${n} new messages`,
  };
  it("builds the ticker", () => {
    const status = { torrserver: { ok: true, latency_ms: 12 }, prowlarr: { ok: true }, active_streams: 2 };
    expect(tickerItems({ device: "Гостиная", status, profile: "Cineko", unread: 1, labels })).toEqual([
      "● ГОСТИНАЯ ONLINE",
      "TORRSERVER 12 MS",
      "2 STREAMS NOW",
      "PROFILE: CINEKO",
      "1 NEW MESSAGES",
    ]);
    const down = { torrserver: { ok: false, latency_ms: null }, prowlarr: { ok: false }, active_streams: 0 };
    expect(tickerItems({ device: null, status: down, profile: "M", unread: 0, labels })).toEqual(["TORRSERVER OFFLINE", "PROWLARR OFFLINE", "0 STREAMS NOW", "PROFILE: M"]);
    expect(tickerItems({ device: "TV", status: null, profile: "M", unread: 0, labels })).toEqual(["● TV ONLINE", "PROFILE: M"]);
  });
  it("reports TorrServer state and ticker speed", () => {
    expect(torrState(null)).toBe("unknown");
    expect(torrState({ torrserver: { ok: true, latency_ms: 3 }, prowlarr: { ok: true }, active_streams: 0 })).toBe("online");
    expect(torrState({ torrserver: { ok: false, latency_ms: null }, prowlarr: { ok: true }, active_streams: 0 })).toBe("offline");
    expect(tickerSeconds("x")).toBe(20);
    expect(tickerSeconds("x".repeat(200))).toBe(64);
  });
  it("picks Russian plural forms", () => {
    expect([1, 2, 5, 11, 21, 22, 25, 112].map(pluralRu)).toEqual([0, 1, 2, 2, 0, 1, 2, 2]);
  });
});

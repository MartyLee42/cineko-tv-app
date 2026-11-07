import { describe, expect, it } from "vitest";
import type { PlaybackSource, Release } from "@martytv/contracts";
import { assessRelease, assessSource, codecKey, containerKey, nextRelease, usesCodec, type Probe } from "./codecs";
import { nextEpisode, packCovers, prevEpisode } from "./episodes";
import { episodeLabel, formatBytes, formatClock, formatSpeed, releaseRow, streamLabel } from "./format";
import { accumulateSeek, playerKey, seekStep } from "./keys";
import { flowScreen, isBusy, reduceFlow, IDLE, type Flow, type PlayContext } from "./session";

const MOVIE = "11111111-2222-4333-8444-555555555555";

function release(p: Partial<Release> = {}): Release {
  return {
    id: "r1",
    title: "Movie.2020.1080p.WEB-DL.H264",
    indexer: "x",
    size_bytes: 2_500_000_000,
    seeders: 40,
    leechers: 2,
    published_at: null,
    info_hash: null,
    resolution: "1080p",
    video_codec: "h264",
    hdr: null,
    audio_codecs: ["aac"],
    languages: ["ru", "en"],
    voiceovers: [],
    release_group: null,
    source_quality: "web-dl",
    year: 2020,
    seasons: [],
    episodes: [],
    is_season_pack: false,
    confidence: 0.95,
    score: 10,
    reasons: [],
    warnings: [],
    ...p,
  };
}

function source(p: Partial<PlaybackSource> = {}): PlaybackSource {
  return {
    id: "s1",
    media_id: MOVIE,
    episode_id: null,
    release: release(),
    status: "ready",
    error: null,
    file: null,
    stream_url: "/api/v1/stream/tok",
    stream_expires_at: null,
    mime_type: "video/mp4",
    media_info: null,
    torrent: null,
    created_at: "2026-01-01T00:00:00Z",
    ...p,
  };
}

const ctx: PlayContext = {
  media_id: MOVIE,
  kind: "movie",
  title: "Movie",
  poster_path: null,
  backdrop_path: null,
  season: null,
  episode: null,
  episode_id: null,
  episode_name: null,
  profile_id: "p1",
  lang: "en",
  player: "builtin",
  app: null,
};

/** A probe answering from supported MIME type prefixes ("…$" = exact). */
function probe(...yes: string[]): Probe {
  return { canPlayType: (t) => (yes.some((y) => (y.endsWith("$") ? t === y.slice(0, -1) : t.startsWith(y))) ? "maybe" : "") };
}
/** Typical desktop Chrome: MP4/WebM, H.264/VP9/AV1, AAC/Opus/MP3/FLAC; no HEVC/AC3/DTS/MKV. */
const chrome = probe(
  "video/mp4; codecs=\"avc1",
  "video/webm",
  "video/mp4; codecs=\"av01",
  "audio/mp4; codecs=\"mp4a.40",
  "audio/webm",
  "audio/mpeg",
  "audio/flac",
  "video/mp4$",
);
/** A Tizen-like engine: HEVC, AC3/E-AC3, MKV; no DTS. */
const tizen = probe("video/mp4$", 'video/mp4; codecs="avc1', 'video/mp4; codecs="hvc1', "video/x-matroska", "audio/mp4; codecs=\"mp4a", "audio/mp4; codecs=\"ac-3", "audio/mp4; codecs=\"ec-3");

describe("codec support decision table", () => {
  it("normalizes codec and container names", () => {
    expect(codecKey("H.264")).toBe("h264");
    expect(codecKey("x265")).toBe("hevc");
    expect(codecKey("dts-hd ma")).toBe("dts");
    expect(codecKey("E-AC3")).toBe("eac3");
    expect(codecKey("pcm_s16le")).toBe("pcm");
    expect(containerKey("matroska,webm", "video/x-matroska")).toBe("matroska");
    expect(containerKey(null, "video/webm")).toBe("webm");
    expect(containerKey("mov,mp4,m4a,3gp", null)).toBe("mp4");
    expect(containerKey(null, "video/mp2t")).toBe("mpegts");
    expect(containerKey(null, null)).toBeNull();
  });

  const info = (container: string, video: string, audio: string[]) => ({
    container,
    video_codec: video,
    width: 1920,
    height: 1080,
    duration_seconds: 5400,
    audio: audio.map((codec, index) => ({ index, codec, language: "en", title: null, channels: 6, default: index === 0 })),
    subtitles: [],
  });

  it.each([
    ["mp4 h264 aac on Chrome", "video/mp4", info("mp4", "h264", ["aac"]), chrome, "ok", []],
    ["mkv h264 aac on Chrome (MKV is lenient via WebM)", "video/x-matroska", info("matroska,webm", "h264", ["aac"]), chrome, "ok", []],
    ["mkv hevc dts on Chrome", "video/x-matroska", info("matroska,webm", "hevc", ["dts"]), chrome, "unlikely", ["HEVC", "DTS"]],
    ["mkv hevc ac3 on Tizen", "video/x-matroska", info("matroska,webm", "hevc", ["ac3"]), tizen, "ok", []],
    ["mkv hevc dts on Tizen", "video/x-matroska", info("matroska,webm", "hevc", ["dts"]), tizen, "unlikely", ["DTS"]],
    ["only the default audio track counts", "video/mp4", info("mp4", "h264", ["aac", "dts"]), chrome, "ok", []],
    ["mpeg-ts on Chrome", "video/mp2t", info("mpegts", "h264", ["aac"]), chrome, "unlikely", ["MPEG-TS"]],
    ["unknown codecs are not judged", "video/mp4", info("mp4", "prores", ["alac"]), chrome, "ok", []],
  ] as const)("%s", (_name, mime, mi, pr, verdict, unsupported) => {
    const s = assessSource(source({ mime_type: mime, media_info: mi as never }), pr);
    expect(s.verdict).toBe(verdict);
    expect(s.unsupported).toEqual(unsupported);
  });

  it("without media_info uses the MIME type and the release's codecs", () => {
    expect(assessSource(source({ mime_type: "video/x-unknown" }), chrome)).toMatchObject({ verdict: "unlikely", unsupported: ["video/x-unknown"] });
    const hevc = assessSource(source({ mime_type: null, release: release({ video_codec: "hevc", audio_codecs: ["ac3", "aac"] }) }), chrome);
    // HEVC fails; audio passes because one of the listed codecs plays.
    expect(hevc.unsupported).toEqual(["HEVC"]);
    expect(hevc.avoid).toEqual(["hevc"]);
    expect(assessRelease(release({ video_codec: "h264", audio_codecs: ["dts"] }), chrome).unsupported).toEqual(["DTS"]);
  });

  it("uses MediaSource.isTypeSupported when canPlayType says no", () => {
    const p: Probe = { canPlayType: () => "", isTypeSupported: (t) => t.includes("hvc1") || t.includes("mp4a") || t === "video/mp4" };
    expect(assessSource(source({ media_info: info("mp4", "hevc", ["aac"]) as never }), p).verdict).toBe("ok");
  });

  it("an engine that throws on a type counts as no", () => {
    const p: Probe = {
      canPlayType: () => {
        throw new Error("x");
      },
    };
    expect(assessRelease(release({ video_codec: "hevc" }), p).unsupported).toEqual(["HEVC", "AAC"]);
  });

  it("picks the next release avoiding failed codecs and tried ones", () => {
    const items = [
      release({ id: "a", video_codec: "hevc" }),
      release({ id: "b", video_codec: "hevc", audio_codecs: ["dts"] }),
      release({ id: "c", video_codec: "h264", warnings: ["likely_unplayable_codec"] }),
      release({ id: "d", video_codec: "h264" }),
    ];
    expect(usesCodec(items[1]!, ["dts"])).toBe(true);
    expect(nextRelease(items, ["a"], ["hevc"])?.id).toBe("d");
    // No avoid list: just the next untried one that should play here.
    expect(nextRelease(items, ["a"], [], chrome)?.id).toBe("d");
    expect(nextRelease(items, [], [])?.id).toBe("a");
    expect(nextRelease(items, ["a", "b", "c", "d"], [])).toBeNull();
    // Disc images are skipped automatically while anything else is left.
    expect(nextRelease([release({ id: "iso", warnings: ["disc_image"] }), release({ id: "mkv" })], [], [])?.id).toBe("mkv");
    // Everything left uses the failing codec → nothing (the picker decides).
    expect(nextRelease(items.slice(0, 2), ["a"], ["hevc"])).toBeNull();
  });
});

describe("remote keys", () => {
  const k = (key: string, keyCode = 0) => playerKey({ key, keyCode, target: null } as unknown as KeyboardEvent);
  it("maps arrows, OK and Back", () => {
    expect(k("Enter", 13)).toBe("ok");
    expect(k("ArrowLeft", 37)).toBe("left");
    expect(k("ArrowRight", 39)).toBe("right");
    expect(k("ArrowUp", 38)).toBe("up");
    expect(k("ArrowDown", 40)).toBe("down");
    expect(k("Escape", 27)).toBe("back");
    expect(k("", 10009)).toBe("back"); // Tizen Return
    expect(k("", 461)).toBe("back"); // webOS Back
  });
  it("maps media keys by name and by TV key code", () => {
    expect(k("MediaPlayPause", 179)).toBe("playpause");
    expect(k("Unidentified", 10252)).toBe("playpause");
    expect(k("", 415)).toBe("play");
    expect(k("", 19)).toBe("pause");
    expect(k("", 413)).toBe("stop");
    expect(k("", 417)).toBe("ff");
    expect(k("", 412)).toBe("rew");
    expect(k("MediaTrackNext", 176)).toBe("next");
    expect(k("", 10233)).toBe("next");
    expect(k("MediaFastForward", 0)).toBe("ff");
    expect(k("a", 65)).toBeNull();
  });
  it("accelerates held seeks and restarts on reversal", () => {
    expect(seekStep(-1, 0)).toBe(-10);
    expect(seekStep(1, 0)).toBe(30);
    expect(seekStep(1, 4)).toBe(60);
    expect(seekStep(1, 10)).toBe(120);
    expect(seekStep(1, 25)).toBe(240);
    let s = accumulateSeek(null, 100, 1, 1000);
    expect(s).toEqual({ target: 130, count: 0, dir: 1 });
    s = accumulateSeek(s, 100, 1, 1000);
    expect(s.target).toBe(160);
    s = accumulateSeek(s, 100, -1, 1000);
    expect(s).toEqual({ target: 150, count: 0, dir: -1 });
    // Clamped to [0, duration - 3].
    expect(accumulateSeek(null, 5, -1, 1000).target).toBe(0);
    expect(accumulateSeek(null, 990, 1, 1000).target).toBe(997);
    expect(accumulateSeek(null, 990, 1, null).target).toBe(1020);
  });
});

describe("flow reducer", () => {
  const r = release();
  const start = (auto: boolean, from: Flow = IDLE) => reduceFlow(from, { type: "start", ctx, release: r, startAt: 0, auto });

  it("picker → preparing → playing", () => {
    let f = reduceFlow(IDLE, { type: "pick", ctx });
    expect(f.phase).toBe("picker");
    f = start(false, f);
    expect(f).toMatchObject({ phase: "preparing", step: "preparing", auto: false });
    expect(isBusy(f)).toBe(true);
    expect(flowScreen(f)).toBe("player");
    f = reduceFlow(f, { type: "source", source: source({ status: "preparing", stream_url: null }) });
    expect(f).toMatchObject({ phase: "preparing", source: { id: "s1" } });
    f = reduceFlow(f, { type: "source", source: source() });
    expect(f).toMatchObject({ phase: "playing", source: { id: "s1" }, release: { id: "r1" } });
  });

  it("source errors become failures and mark the release tried", () => {
    const f = reduceFlow(start(false), { type: "source", source: source({ status: "error", error: "no_metadata", stream_url: null }) });
    expect(f).toMatchObject({ phase: "failed", kind: "error", code: "no_metadata", tried: ["r1"] });
    expect(isBusy(f)).toBe(false);
    // Back / "another" return to the picker, keeping what failed.
    expect(reduceFlow(f, { type: "back" })).toMatchObject({ phase: "picker", tried: ["r1"] });
    expect(reduceFlow(f, { type: "another" })).toMatchObject({ phase: "picker", tried: ["r1"] });
  });

  it("unplayable remembers the failing codecs for the next releases", () => {
    const playing = reduceFlow(start(true), { type: "source", source: source() });
    const f = reduceFlow(playing, { type: "unplayable", reason: "HEVC", avoid: ["hevc"] });
    expect(f).toMatchObject({ phase: "failed", kind: "unplayable", code: "unplayable", reason: "HEVC", avoid: ["hevc"], tried: ["r1"] });
    // A new start for the same title keeps both; another episode keeps the codecs only.
    expect(reduceFlow(f, { type: "start", ctx, release: null, auto: true })).toMatchObject({ tried: ["r1"], avoid: ["hevc"], step: "searching" });
    const ep2 = { ...ctx, kind: "series" as const, season: 1, episode: 2 };
    expect(reduceFlow(f, { type: "start", ctx: ep2, release: null, auto: true })).toMatchObject({ tried: [], avoid: ["hevc"] });
    expect(reduceFlow(f, { type: "start", ctx: { ...ctx, media_id: "other" }, release: null, auto: true })).toMatchObject({ tried: [], avoid: [] });
  });

  it("Back from auto-started playback and from the player exits", () => {
    expect(reduceFlow(start(true), { type: "back" })).toBe(IDLE);
    const playing = reduceFlow(start(false), { type: "source", source: source() });
    expect(reduceFlow(playing, { type: "back" })).toBe(IDLE);
    expect(reduceFlow(playing, { type: "close" })).toBe(IDLE);
  });

  it("a fresh URL replaces the source while playing; other sources are ignored", () => {
    const playing = reduceFlow(start(false), { type: "source", source: source() });
    const fresh = reduceFlow(playing, { type: "source", source: source({ stream_url: "/api/v1/stream/new" }) });
    expect(fresh).toMatchObject({ phase: "playing", source: { stream_url: "/api/v1/stream/new" } });
    expect(reduceFlow(playing, { type: "source", source: source({ id: "other" }) })).toBe(playing);
  });

  it("the player chooser sits between the picker and preparing", () => {
    const picker = reduceFlow(IDLE, { type: "pick", ctx });
    const choose = reduceFlow(picker, { type: "choose", ctx, release: r, auto: false });
    expect(choose).toMatchObject({ phase: "choose", release: { id: "r1" } });
    expect(flowScreen(choose)).toBeNull();
    expect(isBusy(choose)).toBe(false);
    expect(reduceFlow(choose, { type: "back" })).toMatchObject({ phase: "picker" });
    expect(reduceFlow(reduceFlow(IDLE, { type: "choose", ctx, release: null, auto: true }), { type: "back" })).toBe(IDLE);
  });

  it("ctx patches update the title/episode while preparing", () => {
    const f = reduceFlow(start(true), { type: "ctx", patch: { title: "Real", season: 1, episode: 2 } });
    expect(f).toMatchObject({ ctx: { title: "Real", season: 1, episode: 2 } });
    expect(reduceFlow(IDLE, { type: "ctx", patch: { title: "x" } })).toBe(IDLE);
  });
});

describe("previous episode", () => {
  const eps = (season: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `s${season}e${i + 1}`, season_number: season, episode_number: i + 1, name: `Ep ${i + 1}` }));
  const seasons = [{ season_number: 0, episode_count: 3 }, { season_number: 1, episode_count: 8 }, { season_number: 2, episode_count: 6 }];

  it("is the previous episode in the season", () => {
    expect(prevEpisode({ season: 2, episode: 3 }, eps(2, 6), seasons)).toEqual({ season: 2, episode: 2, id: "s2e2", name: "Ep 2" });
    expect(prevEpisode({ season: 2, episode: 3 }, undefined, seasons)).toEqual({ season: 2, episode: 2 });
  });
  it("rolls back to the last episode of the previous season", () => {
    expect(prevEpisode({ season: 2, episode: 1 }, eps(2, 6), seasons)).toEqual({ season: 1, episode: 8 });
    expect(prevEpisode({ season: 2, episode: 1 }, eps(2, 6), seasons, eps(1, 8))).toMatchObject({ season: 1, episode: 8, id: "s1e8" });
  });
  it("none before the very first episode; specials never roll into seasons", () => {
    expect(prevEpisode({ season: 1, episode: 1 }, eps(1, 8), seasons)).toBeNull();
    expect(prevEpisode({ season: 0, episode: 1 }, eps(0, 3), seasons)).toBeNull();
  });
});

describe("next episode", () => {
  const eps = (season: number, n: number, aired = true) =>
    Array.from({ length: n }, (_, i) => ({ id: `s${season}e${i + 1}`, season_number: season, episode_number: i + 1, name: `Ep ${i + 1}`, air_date: aired ? "2020-01-01" : "2999-01-01" }));
  const seasons = [{ season_number: 0 }, { season_number: 1 }, { season_number: 2 }];
  const today = "2026-01-01";

  it("is the next episode in the season", () => {
    expect(nextEpisode({ season: 1, episode: 2 }, eps(1, 8), seasons, undefined, today)).toEqual({ season: 1, episode: 3, id: "s1e3", name: "Ep 3" });
  });
  it("rolls over to the next season (id known only with its list)", () => {
    expect(nextEpisode({ season: 1, episode: 8 }, eps(1, 8), seasons, undefined, today)).toEqual({ season: 2, episode: 1 });
    expect(nextEpisode({ season: 1, episode: 8 }, eps(1, 8), seasons, eps(2, 6), today)).toMatchObject({ season: 2, episode: 1, id: "s2e1" });
  });
  it("stops at unaired episodes, the last season and specials", () => {
    expect(nextEpisode({ season: 1, episode: 2 }, [...eps(1, 2), ...eps(1, 3, false).slice(2)], seasons, undefined, today)).toBeNull();
    expect(nextEpisode({ season: 2, episode: 6 }, eps(2, 6), seasons, undefined, today)).toBeNull();
    expect(nextEpisode({ season: 0, episode: 3 }, eps(0, 3), seasons, undefined, today)).toBeNull();
    expect(nextEpisode({ season: 1, episode: 8 }, eps(1, 8), [...seasons.slice(0, 2), { season_number: 2, air_date: "2999-01-01" }], undefined, today)).toBeNull();
  });
  it("without the season's list: its episode count decides, never a guessed episode (S02E13 of 13 → S03E01)", () => {
    const counted = [{ season_number: 1, episode_count: 13 }, { season_number: 2, episode_count: 13 }, { season_number: 3, episode_count: 13 }];
    expect(nextEpisode({ season: 2, episode: 13 }, undefined, counted, undefined, today)).toEqual({ season: 3, episode: 1 });
    expect(nextEpisode({ season: 2, episode: 13 }, undefined, counted, eps(3, 13), today)).toMatchObject({ season: 3, episode: 1, id: "s3e1" });
    expect(nextEpisode({ season: 2, episode: 5 }, undefined, counted, undefined, today)).toEqual({ season: 2, episode: 6 });
    expect(nextEpisode({ season: 3, episode: 13 }, undefined, counted, undefined, today)).toBeNull();
    // Episode count unknown: no offer at all.
    expect(nextEpisode({ season: 2, episode: 13 }, undefined, seasons, undefined, today)).toBeNull();
  });
  it("knows when a season pack covers the next episode", () => {
    expect(packCovers(release({ is_season_pack: true, seasons: [1] }), 1, 5)).toBe(true);
    expect(packCovers(release({ is_season_pack: true, seasons: [1] }), 2, 1)).toBe(false);
    expect(packCovers(release({ is_season_pack: true, seasons: [1], episodes: [1, 2, 3] }), 1, 4)).toBe(false);
    expect(packCovers(release({ is_season_pack: false, seasons: [1], episodes: [1] }), 1, 2)).toBe(false);
  });
});

describe("formatting", () => {
  it("formats release rows", () => {
    const row = releaseRow(
      release({
        resolution: "2160p",
        hdr: "dolby_vision",
        video_codec: "hevc",
        source_quality: "remux",
        audio_codecs: ["truehd", "ac3", "ac3"],
        languages: ["ru", "en"],
        size_bytes: 58_000_000_000,
        is_season_pack: true,
        seasons: [1],
        episodes: [],
        warnings: ["low_seeders", "something_new"],
      }),
    );
    expect(row).toMatchObject({
      resolution: "4K",
      chips: ["Remux", "Dolby Vision", "HEVC"],
      audio: "TrueHD · AC3",
      languages: "RU · EN",
      size: "54 GB",
      seasonPack: true,
      scope: "S01",
      warnings: ["player.warning.low_seeders"],
    });
    expect(releaseRow(release({ resolution: null, source_quality: null, video_codec: null })).resolution).toBe("—");
    expect(releaseRow(release({ seasons: [1], episodes: [5] })).scope).toBe("S01E05");
    expect(releaseRow(release({ seasons: [1, 3, 2] })).scope).toBe("S01–S03");
  });
  it("formats sizes, speeds, clocks and labels", () => {
    expect(formatBytes(1_500_000_000)).toBe("1.4 GB");
    expect(formatBytes(1_500_000_000, "ru")).toBe("1,4 ГБ");
    expect(formatBytes(850 * 1024 * 1024)).toBe("850 MB");
    expect(formatSpeed(2.5 * 1024 * 1024)).toBe("2.5 MB/s");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(3723)).toBe("1:02:03");
    expect(formatClock(NaN)).toBe("--:--");
    expect(episodeLabel(1, 2, "Pilot")).toBe("S01E02 · Pilot");
    expect(episodeLabel(null, 2)).toBeNull();
    expect(streamLabel({ index: 1, codec: "ac3", language: "rus", title: "Dub", channels: 6, default: true }, 0)).toBe("RUS · AC3 5.1 · Dub");
    expect(streamLabel({ index: 1, codec: "", language: null, title: null, channels: null, default: false }, 2)).toBe("#3");
  });
});

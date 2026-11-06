import { describe, expect, it } from "vitest";
import type { DeviceState, Release } from "@martytv/contracts";
import { translate, type MessageKey } from "@martytv/ui";
import { createPlayController, holdTvProgress, isBusy, PLAY_IDLE, playPayload, playReducer, tvProgress, type PlayAction, type PlayFlow, type PlayRequest } from "./flow";
import {
  applyFilters,
  audioCodecsLabel,
  codecLabel,
  confidencePct,
  coverageLabel,
  episodeFromLabel,
  filterOptions,
  formatSize,
  formatSpeed,
  hdrLabel,
  languageName,
  qualityLabel,
  rankingProfileId,
  releaseParams,
  resolutionLabel,
  sanitizeFilters,
  sourceErrorMessage,
  warningLabels,
} from "./releases";
import { languageOptions, parseMaxSize, prefsFieldErrors, toggleOrdered } from "./prefs";

const t = (k: MessageKey, v?: Record<string, string | number>) => translate("en", k, v);
const tRu = (k: MessageKey, v?: Record<string, string | number>) => translate("ru", k, v);

const rel = (over: Partial<Release> = {}): Release => ({
  id: "r1",
  voiceovers: [],
  title: "Дюна: Часть вторая / Dune: Part Two (2024) WEB-DL 2160p HDR10 | Дубляж, Original",
  indexer: "RuTracker",
  size_bytes: 23.4 * 1024 ** 3,
  seeders: 120,
  leechers: 8,
  published_at: null,
  info_hash: null,
  resolution: "2160p",
  video_codec: "hevc",
  hdr: "hdr10",
  audio_codecs: ["eac3", "ac3"],
  languages: ["ru", "en"],
  release_group: null,
  source_quality: "web-dl",
  year: 2024,
  seasons: [],
  episodes: [],
  is_season_pack: false,
  confidence: 0.934,
  score: 9,
  reasons: [],
  warnings: [],
  ...over,
});

describe("release labels", () => {
  it("formats sizes and speeds", () => {
    expect(formatSize(23.4 * 1024 ** 3)).toBe("23.4 GB");
    expect(formatSize(150 * 1024 ** 3)).toBe("150 GB");
    expect(formatSize(850 * 1024 ** 2)).toBe("850 MB");
    expect(formatSize(0)).toBe("—");
    expect(formatSize(1.5 * 1024 ** 3, "ru")).toBe("1,5 GB");
    expect(formatSpeed(3.4 * 1024 ** 2)).toBe("3.4 MB/s");
    expect(formatSpeed(300 * 1024)).toBe("300 KB/s");
    expect(formatSpeed(0)).toBe("0 KB/s");
  });

  it("names codecs, HDR, quality, resolution and audio", () => {
    expect(resolutionLabel("2160p")).toBe("4K");
    expect(resolutionLabel("720p")).toBe("720p");
    expect(resolutionLabel(null)).toBeNull();
    expect(codecLabel("hevc")).toBe("HEVC");
    expect(codecLabel("h264")).toBe("H.264");
    expect(codecLabel(null)).toBeNull();
    expect(hdrLabel("dolby_vision")).toBe("Dolby Vision");
    expect(hdrLabel("hdr10plus")).toBe("HDR10+");
    expect(qualityLabel("web-dl")).toBe("WEB-DL");
    expect(qualityLabel("telesync")).toBe("TS");
    expect(audioCodecsLabel(["eac3", "ac3", "EAC3"])).toBe("DD+ · DD");
    expect(audioCodecsLabel([])).toBeNull();
  });

  it("names languages in the UI language, falling back to the code", () => {
    expect(languageName("ru", "en")).toBe("Russian");
    expect(languageName("en", "ru")).toBe("Английский");
    expect(languageName("zz-qq-bogus", "en")).toMatch(/ZZ/i);
  });

  it("shows confidence, coverage and warnings", () => {
    expect(confidencePct(0.934)).toBe(93);
    expect(confidencePct(1.2)).toBe(100);
    expect(coverageLabel({ seasons: [1], episodes: [3], is_season_pack: false })).toBe("S01E03");
    expect(coverageLabel({ seasons: [1], episodes: [1, 8, 2], is_season_pack: false })).toBe("S01E01–E08");
    expect(coverageLabel({ seasons: [2], episodes: [], is_season_pack: true })).toBe("S02");
    expect(coverageLabel({ seasons: [3, 1], episodes: [], is_season_pack: true })).toBe("S01–S03");
    expect(coverageLabel({ seasons: [], episodes: [], is_season_pack: false })).toBeNull();
    expect(warningLabels(["low_seeders", "weird_thing"], t)).toEqual(["Few seeders", "weird thing"]);
  });
});

describe("filters", () => {
  const items = [
    rel({ id: "a", resolution: "1080p", languages: ["ru"] }),
    rel({ id: "b", resolution: "2160p", languages: ["ru", "en"] }),
    rel({ id: "c", resolution: "720p", languages: ["uk"] }),
    rel({ id: "d", resolution: null, languages: ["ru", "uk"] }),
  ];

  it("offers resolutions high to low and languages by frequency", () => {
    expect(filterOptions(items)).toEqual({ resolutions: ["2160p", "1080p", "720p"], languages: ["ru", "uk", "en"] });
  });

  it("filters while keeping the server ranking", () => {
    expect(applyFilters(items, { resolution: null, language: "ru" }).map((r) => r.id)).toEqual(["a", "b", "d"]);
    expect(applyFilters(items, { resolution: "2160p", language: "ru" }).map((r) => r.id)).toEqual(["b"]);
    expect(applyFilters(items, { resolution: null, language: null })).toHaveLength(4);
  });

  it("drops filters that no longer match anything", () => {
    expect(sanitizeFilters(items, { resolution: "480p", language: "en" })).toEqual({ resolution: null, language: "en" });
  });
});

describe("ranking & queries", () => {
  const state = (profile_id: string | null): DeviceState => ({ screen: "home", profile_id, media_id: null, playback: null });

  it("ranks for the TV's active profile, else server default", () => {
    expect(rankingProfileId(state("p1"))).toBe("p1");
    expect(rankingProfileId(state(null))).toBeUndefined();
    expect(rankingProfileId(null)).toBeUndefined();
  });

  it("builds release query params", () => {
    expect(releaseParams({ media_id: "m" })).toEqual({});
    expect(releaseParams({ media_id: "m", season_number: 1, episode_number: 2 }, { profile_id: "p", refresh: true, lang: "ru" })).toEqual({
      season: 1,
      episode: 2,
      profile_id: "p",
      refresh: true,
      lang: "ru",
    });
    expect(releaseParams({ media_id: "m", episode_number: 2 })).toEqual({});
  });

  it("reads season/episode from the TV's episode label", () => {
    expect(episodeFromLabel("S01E02 · Pilot")).toEqual({ season: 1, episode: 2 });
    expect(episodeFromLabel("s10e110")).toEqual({ season: 10, episode: 110 });
    expect(episodeFromLabel("Pilot")).toBeNull();
    expect(episodeFromLabel(null)).toBeNull();
  });

  it("maps source errors to player.error.*", () => {
    expect(sourceErrorMessage("no_metadata", t)).toBe(t("player.error.no_metadata"));
    expect(sourceErrorMessage("not_found", t)).toBe(t("player.error.release_unavailable"));
    expect(sourceErrorMessage("boom", t)).toBe("Playback failed (boom).");
    expect(sourceErrorMessage(null, tRu)).toContain("failed");
  });
});

// ---------------------------------------------------------------- flow

const req: PlayRequest = { media_id: "m1", label: "Dune" };
const run = (actions: PlayAction[], from: PlayFlow = PLAY_IDLE) => actions.reduce(playReducer, from);

describe("play flow", () => {
  it("sends media.play at once: no release search or source on the phone", () => {
    let f = run([{ type: "request", req, choice: { kind: "auto", deviceId: "tv" } }]);
    expect(f).toMatchObject({ step: "sending", deviceId: "tv", force: false });
    expect(isBusy(f)).toBe(true);
    f = run([{ type: "outcome", outcome: { kind: "sent" } }], f);
    expect(f).toMatchObject({ step: "done", outcome: { kind: "sent" } });
  });

  it("the payload carries ids only (release, quality, position, player) for the TV to prepare", () => {
    expect(playPayload(req, false)).toEqual({ media_id: "m1" });
    expect(
      playPayload({ ...req, episode_id: "e1", release_id: "r2", quality: 720, position_seconds: 0, player: "msx" }, true),
    ).toEqual({ media_id: "m1", episode_id: "e1", release_id: "r2", quality: 720, position_seconds: 0, player: "msx", force: true });
    // Quality only means something with a chosen (online) release.
    expect(playPayload({ ...req, quality: 720 }, false)).toEqual({ media_id: "m1" });
  });

  it("several TVs ask first", () => {
    const f = run([{ type: "request", req: { ...req, release_id: "r2" }, choice: { kind: "pick", preferred: "b" } }]);
    expect(f).toMatchObject({ step: "picking", preferred: "b" });
    expect(run([{ type: "pick", deviceId: "a" }], f)).toMatchObject({ step: "sending", deviceId: "a", req: { release_id: "r2" } });
    expect(run([{ type: "cancel" }], f)).toBe(PLAY_IDLE);
  });

  it("asks before interrupting playback, then forces", () => {
    let f = run([
      { type: "request", req: { ...req, release_id: "r2" }, choice: { kind: "auto", deviceId: "tv" } },
      { type: "outcome", outcome: { kind: "busy" } },
    ]);
    expect(f).toMatchObject({ step: "confirm" });
    f = run([{ type: "confirm" }], f);
    expect(f).toMatchObject({ step: "sending", force: true });
    f = run([{ type: "outcome", outcome: { kind: "busy" } }], f);
    expect(f).toMatchObject({ step: "done", outcome: { kind: "error", scope: "command", code: "busy_playing" } });
    expect(run([{ type: "outcome", outcome: { kind: "error", code: "device_offline" } }], { step: "sending", req, deviceId: "tv", force: false })).toMatchObject({
      outcome: { kind: "error", scope: "command", code: "device_offline" },
    });
  });

  it("ignores new requests while one is in flight", () => {
    const f = run([{ type: "request", req, choice: { kind: "auto", deviceId: "tv" } }]);
    expect(run([{ type: "request", req: { ...req, media_id: "m2" }, choice: { kind: "auto", deviceId: "tv" } }], f)).toBe(f);
    const done = run([{ type: "outcome", outcome: { kind: "sent" } }], f);
    expect(run([{ type: "request", req, choice: { kind: "auto", deviceId: "tv" } }], done)).toMatchObject({ step: "sending" });
  });

  it("controller sends once per entry and with force on confirm", async () => {
    const calls: string[] = [];
    const seen: PlayFlow[] = [];
    const ctl = createPlayController((f) => seen.push(f), {
      send: async (s) => (calls.push(`send:${s.force}`), { type: "outcome", outcome: s.force ? { kind: "sent" } : { kind: "busy" } }),
    });
    ctl.dispatch({ type: "request", req, choice: { kind: "auto", deviceId: "tv" } });
    ctl.dispatch({ type: "request", req, choice: { kind: "auto", deviceId: "tv" } }); // double tap
    await new Promise((r) => setTimeout(r, 0));
    expect(ctl.get().step).toBe("confirm");
    ctl.dispatch({ type: "confirm" });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["send:false", "send:true"]);
    expect(seen.map((f) => f.step)).toEqual(["sending", "confirm", "sending", "done"]);
  });

  it("controller recovers if the send throws", async () => {
    const ctl = createPlayController(() => {}, { send: () => Promise.reject(new Error("bug")) });
    ctl.dispatch({ type: "request", req, choice: { kind: "auto", deviceId: "tv" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(ctl.get()).toMatchObject({ step: "done", outcome: { kind: "error", code: "failed" } });
  });
});

describe("following the TV after media.play", () => {
  const playback = (o: Record<string, unknown>) => ({ media_id: "m1", episode_id: null, buffering: true, ...o });
  it("opening → searching → loading x% with peers → playing", () => {
    expect(tvProgress(req, null, false)).toEqual({ kind: "opening" });
    expect(tvProgress(req, { screen: "home", media_id: null, playback: null }, false)).toEqual({ kind: "opening" });
    expect(tvProgress(req, { playback: playback({ loading: { stage: "searching", progress: 0.05 } }) }, false)).toEqual({ kind: "searching" });
    expect(
      tvProgress(req, { playback: playback({ loading: { stage: "preloading", progress: 0.42, peers: 14, seeders: 9, download_speed_bps: 2e6, preloaded_bytes: 5e6, release: "1080p" } }) }, true),
    ).toEqual({ kind: "loading", stage: "preloading", pct: 42, peers: 14, seeders: 9, speed: 2e6, buffered: 5e6, release: "1080p" });
    expect(tvProgress(req, { playback: playback({ buffering: false, loading: null }) }, true)).toEqual({ kind: "playing" });
  });

  it("failure on the TV's player screen; another title = the user moved on", () => {
    expect(tvProgress(req, { screen: "player", media_id: "m1", player_error: "no_releases", playback: null }, true)).toEqual({ kind: "failed", code: "no_releases" });
    expect(tvProgress(req, { screen: "home", media_id: null, playback: playback({ media_id: "m9" }) }, true)).toEqual({ kind: "gone" });
    expect(tvProgress(req, { screen: "home", media_id: null, playback: null }, false)).toEqual({ kind: "opening" });
  });
});

describe("preferences helpers", () => {
  it("toggles in priority order", () => {
    expect(toggleOrdered(["ru"], "en")).toEqual(["ru", "en"]);
    expect(toggleOrdered(["ru", "en"], "ru")).toEqual(["en"]);
  });

  it("keeps saved uncommon languages selectable", () => {
    expect(languageOptions(["pt"])).toContain("pt");
    expect(languageOptions([]).slice(0, 3)).toEqual(["ru", "en", "uk"]);
  });

  it("parses max size", () => {
    expect(parseMaxSize("")).toBeNull();
    expect(parseMaxSize(" 4,5 ")).toBe(4.5);
    expect(parseMaxSize("40")).toBe(40);
    expect(parseMaxSize("0")).toBe("invalid");
    expect(parseMaxSize("2000")).toBe("invalid");
    expect(parseMaxSize("abc")).toBe("invalid");
  });

  it("routes server field errors to editor fields", () => {
    expect(prefsFieldErrors({ languages: "bad", max_size_gb: "range", lists: "too many" })).toEqual({
      audio: "bad",
      subtitles: "bad",
      max_size: "range",
      other: "too many",
    });
    expect(prefsFieldErrors({})).toEqual({});
  });
});

describe("holdTvProgress", () => {
  const loading = (pct: number, buffered: number | null) =>
    ({ kind: "loading", stage: "preloading", pct, peers: 3, seeders: 1, speed: 0, buffered, release: null }) as const;
  it("never shows less than before for the same request", () => {
    const peak = { pct: 0, buffered: 0 };
    expect(holdTvProgress(loading(40, 10), peak)).toMatchObject({ pct: 40, buffered: 10 });
    expect(holdTvProgress(loading(0, 2), peak)).toMatchObject({ pct: 40, buffered: 10 });
    expect(holdTvProgress({ kind: "playing" }, peak)).toEqual({ kind: "playing" });
    expect(holdTvProgress(loading(55, null), peak)).toMatchObject({ pct: 55, buffered: 10 });
  });
});

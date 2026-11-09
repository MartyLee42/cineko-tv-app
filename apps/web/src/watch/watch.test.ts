import { describe, expect, it } from "vitest";
import type { ContinueItem, HistoryItem, MediaProgress, MediaSummary, WatchProgress } from "@martytv/contracts";
import { needsPin, resolveActiveProfile } from "./profile";
import { affectsCatalog, affectsForYou, cachedDesign, DEFAULT_SETTINGS, mergeSettings, parseDesign, parseTheme, supportsLight } from "./settings";
import { applyWatchedLocally, continueInfo, episodeProgressMap, formatClock, formatLeft, resumeState, seasonProgress } from "./format";
import { pendingRatings } from "./rate";
import { buildSavePlan, installHint, nextStep, prevStep, shouldShowOnboarding, STEPS, stepNumber } from "./onboarding";
import { activityPercent } from "./admin";
import { addVoiceover, moveItem } from "../play/prefs";
import { trackLabel, voiceoverLabel } from "../play/releases";

const NOW = Date.parse("2026-10-29T12:00:00Z");

const wp = (over: Partial<WatchProgress> = {}): WatchProgress => ({
  media_id: "m1",
  episode_id: null,
  season_number: null,
  episode_number: null,
  position_seconds: 0,
  duration_seconds: 6000,
  percent: 0,
  completed: false,
  completed_at: null,
  updated_at: "2026-10-29T10:00:00Z",
  device_id: null,
  source_id: null,
  ...over,
});

const media = (over: Partial<MediaSummary> = {}): MediaSummary => ({
  id: "m1",
  kind: "movie",
  tmdb_id: 1,
  title: "Dune",
  original_title: "Dune",
  year: 2024,
  release_date: null,
  overview: "",
  poster_path: null,
  backdrop_path: null,
  rating: null,
  vote_count: 0,
  genre_ids: [],
  ...over,
});

describe("active profile", () => {
  const profiles = [{ id: "a" }, { id: "b" }];
  it("keeps the remembered profile when it still exists", () => {
    expect(resolveActiveProfile(profiles, "b")).toBe("b");
  });
  it("falls back to the first profile", () => {
    expect(resolveActiveProfile(profiles, "gone")).toBe("a");
    expect(resolveActiveProfile(profiles, null)).toBe("a");
  });
  it("is null without profiles", () => {
    expect(resolveActiveProfile([], "a")).toBeNull();
    expect(resolveActiveProfile(undefined, null)).toBeNull();
  });
  it("asks for the PIN only when switching to a locked profile", () => {
    expect(needsPin({ id: "b", has_pin: true }, "a")).toBe(true);
    expect(needsPin({ id: "a", has_pin: true }, "a")).toBe(false);
    expect(needsPin({ id: "b", has_pin: false }, "a")).toBe(false);
  });
});

describe("settings", () => {
  it("family sharing is opt-in; showing the family refetches «Для вас»", () => {
    expect(DEFAULT_SETTINGS.share_with_family).toBe(false);
    expect(DEFAULT_SETTINGS.show_family).toBe(true);
    expect(affectsForYou({ show_family: false })).toBe(true);
    expect(affectsForYou({ share_with_family: true })).toBe(false);
  });
  it("«Подборки на главной» are on by default and rebuild «Для вас»", () => {
    expect(DEFAULT_SETTINGS.show_curated).toBe(true);
    expect(affectsForYou({ show_curated: false })).toBe(true);
  });
  it("fills defaults and applies a partial patch (optimistic update)", () => {
    const server = { ...DEFAULT_SETTINGS, theme: "dark" as const, hide_anime: true };
    const next = mergeSettings(server, { hide_anime: false, loading_style: "film_reel" });
    expect(next).toEqual({ ...DEFAULT_SETTINGS, theme: "dark", hide_anime: false, loading_style: "film_reel" });
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    // Older servers may omit new fields.
    expect(mergeSettings({ theme: "light" }).autoplay_next_episode).toBe(true);
  });
  it("knows which changes refetch the catalog", () => {
    expect(affectsCatalog({ hide_anime: true })).toBe(true);
    expect(affectsCatalog({ hide_watched: false })).toBe(true);
    expect(affectsCatalog({ theme: "light" })).toBe(false);
  });
  it("parses cached themes", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("weird")).toBe("system");
    expect(parseTheme(null)).toBe("system");
    expect(parseDesign("terminal")).toBe("terminal");
    expect(parseDesign("nope")).toBe("wireframe");
    expect(supportsLight("kinozal")).toBe(true);
    expect(supportsLight("projector")).toBe(false);
    for (const d of ["wireframe", "cyberpunk", "deco"] as const) {
      expect(parseDesign(d)).toBe(d);
      expect(supportsLight(d)).toBe(false);
    }
  });
});

describe("progress formatting", () => {
  it("formats clock and time left", () => {
    expect(formatClock(2530)).toBe("42:10");
    expect(formatClock(3730)).toBe("1:02:10");
    expect(formatLeft(wp({ position_seconds: 2530, duration_seconds: 6000 }), "en")).toBe("58 min");
    expect(formatLeft(wp({ position_seconds: 0, duration_seconds: 4200 }), "en")).toBe("1 h 10 min");
    expect(formatLeft(wp({ position_seconds: 5990, duration_seconds: 6000 }), "en")).toBe("< 1 min");
    expect(formatLeft(wp({ position_seconds: 600, duration_seconds: 1800 }), "ru")).toBe("20 мин");
    expect(formatLeft(wp({ duration_seconds: null }), "en")).toBeNull();
  });
  it("picks start / resume / watch again", () => {
    expect(resumeState(null)).toEqual({ kind: "start" });
    expect(resumeState(wp({ position_seconds: 10 }))).toEqual({ kind: "start" });
    expect(resumeState(wp({ position_seconds: 2530, percent: 0.42 }))).toEqual({ kind: "resume", position: 2530, percent: 0.42 });
    expect(resumeState(wp({ completed: true, position_seconds: 5900 }))).toEqual({ kind: "again" });
  });
});

const series = (over: Partial<MediaProgress> = {}): MediaProgress => ({
  media_id: "s1",
  kind: "series",
  movie: null,
  episodes: [],
  seasons: [
    { season_number: 1, completed: 5, total: 10 },
    { season_number: 2, completed: 0, total: 8 },
  ],
  next_up: null,
  ...over,
});

describe("season progress", () => {
  it("reports done/total", () => {
    expect(seasonProgress(series(), 1)).toEqual({ done: 5, total: 10, ratio: 0.5, complete: false });
    expect(seasonProgress(series({ seasons: [{ season_number: 1, completed: 12, total: 10 }] }), 1)?.complete).toBe(true);
    expect(seasonProgress(series(), 3)).toBeNull();
    expect(seasonProgress(undefined, 1)).toBeNull();
  });

  it("applies manual watched toggles locally", () => {
    const eps = [1, 2, 3].map((n) => ({ id: `e${n}`, season_number: 2, episode_number: n }));
    const all = applyWatchedLocally(series(), { watched: true, season_number: 2 }, eps, "2026-10-29T12:00:00Z");
    expect(all.seasons.find((s) => s.season_number === 2)?.completed).toBe(3);
    expect(episodeProgressMap(all).get("e2")?.completed).toBe(true);
    const one = applyWatchedLocally(all, { watched: false, episode_id: "e2" }, eps);
    expect(one.seasons.find((s) => s.season_number === 2)?.completed).toBe(2);
    expect(episodeProgressMap(one).get("e2")?.percent).toBe(0);
    const movie = applyWatchedLocally({ ...series(), kind: "movie", seasons: [] }, { watched: true });
    expect(movie.movie?.completed).toBe(true);
  });
});

describe("continue watching", () => {
  it("resumes an in-progress episode", () => {
    const item: ContinueItem = {
      media: media({ id: "s1", kind: "series" }),
      progress: wp({ media_id: "s1", episode_id: "e5", season_number: 1, episode_number: 5, position_seconds: 600, percent: 0.3 }),
      next_up: null,
    };
    expect(continueInfo(item)).toEqual({ code: "S01E05", percent: 0.3, position: 600, episodeId: "e5", href: "/title/s1?season=1&episode=5" });
  });
  it("starts the next episode after a finished one", () => {
    const item: ContinueItem = {
      media: media({ id: "s1", kind: "series" }),
      progress: wp({ completed: true, season_number: 1, episode_number: 4 }),
      next_up: { episode_id: "e5", season_number: 1, episode_number: 5, name: "Five", air_date: null },
    };
    const info = continueInfo(item);
    expect(info.code).toBe("S01E05");
    expect(info.position).toBeNull();
    expect(info.percent).toBe(0);
  });
  it("links movies without episode params", () => {
    expect(continueInfo({ media: media(), progress: wp({ position_seconds: 100, percent: 0.1 }), next_up: null }).href).toBe("/title/m1");
  });
});

describe("rate after watching", () => {
  const h = (m: Partial<MediaSummary>, p: Partial<WatchProgress>): HistoryItem => ({ media: media(m), progress: wp(p) });
  it("lists recent unrated completions once per title", () => {
    const items = [
      h({ id: "a" }, { completed: true, completed_at: "2026-10-29T08:00:00Z" }),
      h({ id: "a" }, { completed: true, completed_at: "2026-10-28T08:00:00Z" }),
      h({ id: "b", me: { progress_percent: 1, completed: true, in_watchlist: false, favorite: false, rating: 8 } }, { completed: true, completed_at: "2026-10-29T08:00:00Z" }),
      h({ id: "c" }, { completed: false }),
      h({ id: "d" }, { completed: true, completed_at: "2026-10-20T08:00:00Z" }),
      h({ id: "e" }, { completed: true, completed_at: "2026-10-29T09:00:00Z" }),
    ];
    expect(pendingRatings(items, new Set(), NOW).map((m) => m.id)).toEqual(["a", "e"]);
    expect(pendingRatings(items, new Set(["a"]), NOW).map((m) => m.id)).toEqual(["e"]);
  });
  it("uses an older finished episode when the newest is in progress", () => {
    const items = [
      h({ id: "s", kind: "series" }, { completed: false, episode_id: "e2" }),
      h({ id: "s", kind: "series" }, { completed: true, episode_id: "e1", completed_at: "2026-10-29T07:00:00Z" }),
    ];
    expect(pendingRatings(items, new Set(), NOW).map((m) => m.id)).toEqual(["s"]);
  });
});

describe("onboarding", () => {
  it("walks the steps", () => {
    expect(STEPS[0]).toBe("look");
    expect(nextStep("look")).toBe("profile");
    expect(nextStep("done")).toBe("done");
    expect(prevStep("look")).toBe("look");
    expect(prevStep("content")).toBe("playback");
    expect(stepNumber("done")).toBe(STEPS.length);
  });
  it("shows only for loaded, unfinished settings (and not under automation unless forced)", () => {
    const env = { webdriver: false, forced: false };
    expect(shouldShowOnboarding(undefined, env)).toBe(false);
    expect(shouldShowOnboarding({ onboarding_completed: true }, env)).toBe(false);
    expect(shouldShowOnboarding({ onboarding_completed: false }, env)).toBe(true);
    expect(shouldShowOnboarding({ onboarding_completed: false }, { webdriver: true, forced: false })).toBe(false);
    expect(shouldShowOnboarding({ onboarding_completed: false }, { webdriver: true, forced: true })).toBe(true);
  });
  it("saves only what changed and always completes", () => {
    const initialPrefs = {
      ui_language: "en" as const,
      preferred_audio_languages: ["ru"],
      preferred_subtitle_languages: [],
      preferred_resolution: "1080p" as const,
      max_size_gb: null,
      preferred_codecs: [],
      preferred_voiceovers: [],
    };
    const skip = buildSavePlan({
      settings: {},
      profile: { name: "Cineko", avatar: "", color: "#6366f1" },
      initialProfile: { name: "Cineko", avatar: "", color: "#6366f1" },
      prefs: { preferred_audio_languages: ["ru"], preferred_voiceovers: [], preferred_resolution: "1080p", max_size_gb: null },
      initialPrefs,
    });
    expect(skip).toEqual({ settings: { onboarding_completed: true }, profile: null, prefs: null });

    const full = buildSavePlan({
      settings: { theme: "light", hide_anime: true },
      profile: { name: " Cineko Jr ", avatar: "🦊", color: "#6366f1" },
      initialProfile: { name: "Cineko", avatar: "", color: "#6366f1" },
      prefs: { preferred_audio_languages: ["ru", "en"], preferred_voiceovers: ["LostFilm"], preferred_resolution: "2160p", max_size_gb: 40 },
      initialPrefs,
    });
    expect(full.settings).toEqual({ theme: "light", hide_anime: true, onboarding_completed: true });
    expect(full.profile).toEqual({ name: "Cineko Jr", avatar: "🦊" });
    expect(full.prefs).toEqual({ ...initialPrefs, preferred_audio_languages: ["ru", "en"], preferred_voiceovers: ["LostFilm"], preferred_resolution: "2160p", max_size_gb: 40 });
  });
  it("offers the right install hint", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
    expect(installHint(iphone, false, false)).toBe("ios");
    expect(installHint(iphone, true, false)).toBeNull();
    expect(installHint("Android Chrome", false, true)).toBe("prompt");
    expect(installHint("Android Chrome", false, false)).toBeNull();
  });
});

describe("admin activity", () => {
  it("computes playback percent", () => {
    expect(activityPercent({ position_seconds: 30, duration_seconds: 60 })).toBe(0.5);
    expect(activityPercent({ position_seconds: 30, duration_seconds: null })).toBeNull();
    expect(activityPercent({ position_seconds: null, duration_seconds: 60 })).toBeNull();
  });
});

describe("voice-overs", () => {
  it("labels chips compactly", () => {
    expect(voiceoverLabel({ kind: "dub", studio: null, language: "ru" })).toBe("Dub");
    expect(voiceoverLabel({ kind: "mvo", studio: "LostFilm", language: "ru" })).toBe("MVO · LostFilm");
    expect(voiceoverLabel({ kind: "avo", studio: "Гаврилов", language: "ru" })).toBe("AVO · Гаврилов");
    expect(voiceoverLabel({ kind: "original", studio: null, language: "en" })).toBe("Original EN");
    expect(voiceoverLabel({ kind: null, studio: null, language: "ru" })).toBe("RU");
  });
  it("labels audio tracks as language · title", () => {
    expect(trackLabel({ label: "LostFilm", language: "ru" }, "ru")).toBe("Русский · LostFilm");
    expect(trackLabel({ label: "Russian", language: "ru" }, "en")).toBe("Russian");
    // A language-only engine label falls back to the file's studio title.
    expect(trackLabel({ label: "rus", title: "MovieDalen", language: "rus" }, "ru")).toBe("Русский · MovieDalen");
    expect(trackLabel({ label: "Russian", title: "LostFilm", language: "ru" }, "ru")).toBe("Русский · LostFilm");
    expect(trackLabel({ title: "MovieDalen", language: "rus" }, "ru")).toBe("Русский · MovieDalen");
    expect(trackLabel({ label: "Track 2", language: "en" }, "en")).toBe("English");
    expect(trackLabel({ label: "Commentary", language: null }, "en")).toBe("Commentary");
    expect(trackLabel({ title: null, language: "en" }, "en")).toBe("English");
  });
  it("edits the ordered studio list", () => {
    expect(addVoiceover(["LostFilm"], "  lostfilm ")).toEqual(["LostFilm"]);
    expect(addVoiceover(["LostFilm"], " NewStudio ")).toEqual(["LostFilm", "NewStudio"]);
    expect(addVoiceover(Array.from({ length: 10 }, (_, i) => `s${i}`), "x")).toHaveLength(10);
    expect(moveItem(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });
});

describe("the design before sign-in", () => {
  const store = (m: Record<string, string>) => (k: string) => m[k] ?? null;
  it("prefers the PWA's own last design over the key the TV app shares", () => {
    expect(cachedDesign(store({ "martytv.web_design": "noir", "martytv.design": "wireframe" }))).toBe("noir");
  });
  it("falls back to the shared key (older installs), then «Каркас»", () => {
    expect(cachedDesign(store({ "martytv.design": "deco" }))).toBe("deco");
    expect(cachedDesign(store({}))).toBe("wireframe");
    expect(cachedDesign(store({ "martytv.web_design": "nope" }))).toBe("wireframe");
  });
});

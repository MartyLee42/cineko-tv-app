import { describe, expect, it } from "vitest";
import type { MediaProgress, WatchProgress } from "@martytv/contracts";
import { barFraction, focusEpisodeIndex, formatLeft, resumeChoice, seasonCount, suggestedEpisode, timeLeft } from "./resume";

function wp(p: Partial<WatchProgress> = {}): WatchProgress {
  return {
    media_id: "m",
    episode_id: null,
    season_number: null,
    episode_number: null,
    position_seconds: 0,
    duration_seconds: 3600,
    percent: 0,
    completed: false,
    completed_at: null,
    updated_at: "2026-10-01T00:00:00Z",
    device_id: null,
    source_id: null,
    ...p,
  };
}

function mp(p: Partial<MediaProgress> = {}): MediaProgress {
  return { media_id: "m", kind: "series", movie: null, episodes: [], seasons: [], next_up: null, ...p };
}

describe("resumeChoice", () => {
  it("offers resume for a meaningful position", () => {
    expect(resumeChoice(wp({ position_seconds: 2530 }))).toEqual({ kind: "resume", at: 2530 });
  });
  it("starts from the beginning without progress or under 30 s", () => {
    expect(resumeChoice(null)).toEqual({ kind: "start" });
    expect(resumeChoice(wp({ position_seconds: 12 }))).toEqual({ kind: "start" });
  });
  it("completed → watch again", () => {
    expect(resumeChoice(wp({ position_seconds: 3500, completed: true }))).toEqual({ kind: "again" });
    expect(resumeChoice(wp({ position_seconds: 3598 }))).toEqual({ kind: "again" });
  });
});

describe("next up on Details", () => {
  const eps = [
    { id: "e1", episode_number: 1 },
    { id: "e2", episode_number: 2 },
    { id: "e3", episode_number: 3 },
  ];
  it("suggests the server's next_up", () => {
    const p = mp({ next_up: { episode_id: "e3", season_number: 2, episode_number: 3, name: "x", air_date: null } });
    expect(suggestedEpisode(p)).toEqual({ season: 2, episode: 3, id: "e3" });
  });
  it("falls back to the latest in-progress episode", () => {
    const p = mp({
      episodes: [
        wp({ episode_id: "a", season_number: 1, episode_number: 1, updated_at: "2026-01-01T00:00:00Z" }),
        wp({ episode_id: "b", season_number: 1, episode_number: 4, updated_at: "2026-03-01T00:00:00Z" }),
        wp({ episode_id: "c", season_number: 1, episode_number: 5, completed: true, updated_at: "2026-04-01T00:00:00Z" }),
      ],
    });
    expect(suggestedEpisode(p)).toEqual({ season: 1, episode: 4, id: "b" });
    expect(suggestedEpisode(null)).toBeNull();
  });
  it("focus: remembered > requested > suggested > first", () => {
    expect(focusEpisodeIndex(eps, { remembered: 0, requested: 2, suggestedId: "e3" })).toBe(0);
    expect(focusEpisodeIndex(eps, { requested: 2, suggestedId: "e3" })).toBe(1);
    expect(focusEpisodeIndex(eps, { suggestedId: "e3" })).toBe(2);
    expect(focusEpisodeIndex(eps, { suggestedId: "zz" })).toBe(0);
    expect(focusEpisodeIndex(eps, { remembered: 9 })).toBe(0);
  });
  it("season counts", () => {
    const p = mp({ seasons: [{ season_number: 1, completed: 5, total: 10 }, { season_number: 2, completed: 0, total: 0 }] });
    expect(seasonCount(p, 1)).toEqual({ completed: 5, total: 10 });
    expect(seasonCount(p, 2)).toBeNull();
  });
});

describe("display helpers", () => {
  it("bar and time left", () => {
    expect(barFraction(null)).toBeNull();
    expect(barFraction(0)).toBeNull();
    expect(barFraction(1.4)).toBe(1);
    expect(timeLeft(wp({ position_seconds: 600 }))).toBe(3000);
    expect(formatLeft(3000, "en")).toBe("50 min");
    expect(formatLeft(4380, "ru")).toBe("1 ч 13 мин");
  });
});

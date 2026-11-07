import { describe, expect, it } from "vitest";
import type { PlaybackSource, Release } from "@martytv/contracts";
import type { Flow, PlayContext } from "./player/session";
import { playToResume, RESUME_KEY, RESUME_TTL_MS, saveResume, takeResume } from "./resume";

const ctx: PlayContext = {
  media_id: "m1",
  kind: "series",
  title: "Show",
  poster_path: null,
  backdrop_path: null,
  season: 1,
  episode: 3,
  episode_id: "e3",
  episode_name: null,
  profile_id: "p1",
  lang: "ru",
  player: "builtin",
  app: null,
  start_at: 600,
};
const release = { id: "r1" } as Release;
const source = { id: "s1" } as PlaybackSource;
const attempts = { tried: [], avoid: [] };

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), map: m };
}

describe("playToResume", () => {
  it("restarts playback at the player's position with the same source", () => {
    const f: Flow = { phase: "playing", ctx, release, source, startAt: 600, auto: false, ...attempts };
    expect(playToResume(f, 1234.7)).toEqual({ media_id: "m1", episode_id: "e3", source_id: "s1", position_seconds: 1234, player: "builtin" });
  });
  it("a load still starting (the incident: the loader's chunk was gone) resumes at its start, with the release", () => {
    const f: Flow = { phase: "preparing", ctx, step: "preparing", release, source: null, startAt: 600, auto: true, ...attempts };
    expect(playToResume(f, 0)).toEqual({ media_id: "m1", episode_id: "e3", release_id: "r1", position_seconds: 600, player: "builtin" });
    const searching: Flow = { phase: "preparing", ctx: { ...ctx, episode_id: null, player: null }, step: "searching", release: null, source: null, startAt: 0, auto: true, ...attempts };
    expect(playToResume(searching, 0)).toEqual({ media_id: "m1" });
  });
  it("nothing to resume when idle, in the picker or after a failure", () => {
    expect(playToResume({ phase: "idle" }, 0)).toBeNull();
    expect(playToResume({ phase: "picker", ctx, ...attempts }, 0)).toBeNull();
    expect(playToResume({ phase: "failed", ctx, kind: "error", code: "x", reason: null, release: null, auto: false, ...attempts }, 0)).toBeNull();
  });
});

describe("resume persistence", () => {
  it("round-trips once", () => {
    const s = memStore();
    saveResume({ play: { media_id: "m1", position_seconds: 30 } }, 1000, s);
    expect(takeResume(2000, s)).toEqual({ play: { media_id: "m1", position_seconds: 30 } });
    // Read once: a later start doesn't jump into the film again.
    expect(takeResume(2000, s)).toBeNull();
    saveResume({ open: { media_id: "m2", season_number: 2 } }, 1000, s);
    expect(takeResume(1500, s)).toEqual({ open: { media_id: "m2", season_number: 2 } });
  });
  it("drops stale, malformed or cleared entries", () => {
    const s = memStore();
    saveResume({ play: { media_id: "m1" } }, 1000, s);
    expect(takeResume(1000 + RESUME_TTL_MS + 1, s)).toBeNull();
    expect(s.map.has(RESUME_KEY)).toBe(false);
    s.setItem(RESUME_KEY, "{oops");
    expect(takeResume(1000, s)).toBeNull();
    s.setItem(RESUME_KEY, JSON.stringify({ at: 1000, play: { media_id: "" } }));
    expect(takeResume(1000, s)).toBeNull();
    saveResume({ play: { media_id: "m1" } }, 1000, s);
    saveResume(null, 1000, s);
    expect(takeResume(1000, s)).toBeNull();
  });
  it("never throws without storage", () => {
    expect(() => saveResume({ play: { media_id: "m1" } }, 0, null)).not.toThrow();
    expect(takeResume(0, null)).toBeNull();
  });
});

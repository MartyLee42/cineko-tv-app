import { describe, expect, it } from "vitest";
import { detectDeviceClass, isLayeredKey, mergeLayers, parseDeviceClass, seedPatch, splitPatch, withTvOwnDefaults } from "./deviceSettings";

describe("layers", () => {
  const base = { design: "deco", theme: "light", min_votes: 300, autoplay_countdown: true };
  it("layered keys win, per-profile keys don't, later layers win", () => {
    expect(mergeLayers(base, { design: "matrix", min_votes: 5000 })).toEqual({ ...base, design: "matrix" });
    expect(mergeLayers(base, { design: "matrix" }, { design: "wireframe", autoplay_countdown: false })).toEqual({
      ...base,
      design: "wireframe",
      autoplay_countdown: false,
    });
    expect(mergeLayers(base, null, { theme: undefined }, { theme: null as unknown as string })).toEqual(base);
  });
  it("splits a patch", () => {
    expect(splitPatch({ design: "deco", hide_anime: true, skip_segments: "auto" } as Record<string, unknown>)).toEqual({
      base: { hide_anime: true },
      layer: { design: "deco", skip_segments: "auto" },
    });
  });
  it("taste and content stay per profile", () => {
    for (const k of ["min_votes", "taste_note", "sources", "hide_anime", "video_quality", "share_with_family", "poster_rating"]) expect(isLayeredKey(k)).toBe(false);
    for (const k of ["design", "design_surprise", "design_favorites", "theme", "autoplay_next_episode", "skip_segments"]) expect(isLayeredKey(k)).toBe(true);
  });
});

describe("a TV's own options", () => {
  it("fills defaults", () => {
    expect(withTvOwnDefaults({ screensaver: "dvd" }, "kk")).toMatchObject({ screensaver: "dvd", language: "kk", startup_intro: true, ui_sounds: false, speedtest: true });
    expect(withTvOwnDefaults(null).language).toBe("ru");
  });
  it("seeds only what the server lacks", () => {
    expect(seedPatch({ screensaver: "off" }, { screensaver: "dvd", ui_sounds: true, language: "en" })).toEqual({ ui_sounds: true, language: "en" });
    expect(seedPatch(null, { calm_motion: true })).toEqual({ calm_motion: true });
    expect(seedPatch({ ui_sounds: false, calm_motion: true }, { ui_sounds: true, calm_motion: false })).toEqual({});
  });
});

describe("device class", () => {
  const desk = { ua: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130", coarse: false, width: 1920, height: 1080 };
  it("phones and tablets are mobile, computers desktop", () => {
    expect(detectDeviceClass(desk)).toBe("desktop");
    expect(detectDeviceClass({ ...desk, ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari" })).toBe("mobile");
    expect(detectDeviceClass({ ...desk, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" })).toBe("mobile");
    // iPadOS asks for the desktop site: touch-only, tablet screen.
    expect(detectDeviceClass({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari", coarse: true, width: 1024, height: 1366 })).toBe("mobile");
    // A touch laptop with a big screen stays a computer.
    expect(detectDeviceClass({ ...desk, coarse: true, width: 2560, height: 1440 })).toBe("desktop");
  });
  it("parses stored values", () => {
    expect(parseDeviceClass("mobile")).toBe("mobile");
    expect(parseDeviceClass("tv")).toBeNull();
    expect(parseDeviceClass(null)).toBeNull();
  });
});

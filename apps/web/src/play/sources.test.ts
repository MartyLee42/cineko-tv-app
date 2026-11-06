import { describe, expect, it } from "vitest";
import {
  activeMarker,
  autoSkipDue,
  markerKey,
  skipMode,
  skipTarget,
  episodeRanges,
  groupProviders,
  hlsMode,
  isAndroid,
  isSourceOn,
  onlineGroup,
  qualitiesLabel,
  setSourceOn,
  variantHasEpisode,
} from "@martytv/media-types";
import { assessForBrowser, detectBrowser, type Probe } from "./browserSupport";
import { qualityReload, reloadUrl } from "../player/logic";
import { sourceStatusKey } from "./SourcesSettings";

const ALL = ["prowlarr", "jacred", "anilibria"];

describe("source selection ↔ \"all\"", () => {
  it("everything is on for \"all\" (and for a missing setting)", () => {
    expect(isSourceOn("all", "jacred")).toBe(true);
    expect(isSourceOn(undefined, "jacred")).toBe(true);
    expect(isSourceOn(["prowlarr"], "jacred")).toBe(false);
  });

  it("switching one off turns \"all\" into the explicit rest", () => {
    expect(setSourceOn("all", ALL, "jacred", false)).toEqual(["prowlarr", "anilibria"]);
  });

  it("switching the last one back on returns to \"all\" (future sources included)", () => {
    expect(setSourceOn(["prowlarr", "anilibria"], ALL, "jacred", true)).toBe("all");
    expect(setSourceOn(["anilibria", "prowlarr"], ALL, "jacred", true)).toBe("all");
  });

  it("keeps the registry order and drops duplicates", () => {
    expect(setSourceOn(["anilibria"], ALL, "prowlarr", true)).toEqual(["prowlarr", "anilibria"]);
    expect(setSourceOn(["prowlarr"], ALL, "prowlarr", true)).toEqual(["prowlarr"]);
  });

  it("can switch everything off (an empty list, not \"all\")", () => {
    expect(setSourceOn(["jacred"], ALL, "jacred", false)).toEqual([]);
  });

  it("keeps unknown ids that are still selected", () => {
    expect(setSourceOn(["old", "prowlarr"], ALL, "jacred", true)).toEqual(["prowlarr", "jacred", "old"]);
  });

  it("explains unavailable sources", () => {
    const base = { available: true, enabled_by_admin: true, needs_credentials: false, configured: true, healthy: true as boolean | null };
    expect(sourceStatusKey(base)).toBeNull();
    expect(sourceStatusKey({ ...base, enabled_by_admin: false, available: false })).toBe("sources.settings.disabled_by_admin");
    expect(sourceStatusKey({ ...base, configured: false, needs_credentials: true, available: false })).toBe("sources.settings.needs_login");
    expect(sourceStatusKey({ ...base, healthy: false })).toBe("sources.settings.unhealthy");
  });
});

const v = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  provider: { id: "anilibria", name: "AniLiberty", kind: "anime" },
  episode: null as number | null,
  episodes: [] as number[],
  ...o,
});

describe("online group", () => {
  it("shows anime variants, and failed providers as a status line", () => {
    const g = onlineGroup({
      items: [v("o1"), v("o2", { provider: { id: "x", name: "X", kind: "online" } })],
      providers: [
        { id: "anilibria", name: "AniLiberty", kind: "anime", status: "ok" },
        { id: "slow", name: "Slow", kind: "anime", status: "timeout" },
      ],
    });
    expect(g.items.map((x) => x.id)).toEqual(["o1"]);
    expect(g.failed.map((p) => p.id)).toEqual(["slow"]);
    expect(g.show).toBe(true);
    expect(groupProviders(g.items, g.failed)).toEqual(["AniLiberty", "Slow"]);
  });

  it("is hidden when nothing was found and nothing failed", () => {
    expect(onlineGroup({ items: [], providers: [{ id: "anilibria", name: "AniLiberty", kind: "anime", status: "empty" }] }).show).toBe(false);
    expect(onlineGroup(undefined).show).toBe(false);
  });

  it("formats episodes and qualities", () => {
    expect(episodeRanges([1, 2, 3, 4, 6, 8, 9])).toBe("1–4, 6, 8, 9");
    expect(episodeRanges([3, 1, 2])).toBe("1–3");
    expect(qualitiesLabel([480, 1080, 720])).toBe("1080p · 720p · 480p");
  });

  it("knows which variants have the requested episode", () => {
    expect(variantHasEpisode(v("a", { episode: 3 }), 3)).toBe(true);
    expect(variantHasEpisode(v("a", { episode: 3 }), 4)).toBe(false);
    expect(variantHasEpisode(v("a", { episodes: [1, 2] }), 4)).toBe(false);
    expect(variantHasEpisode(v("a", { episodes: [1, 2] }), 2)).toBe(true);
    expect(variantHasEpisode(v("a"), null)).toBe(true);
  });
});

describe("HLS: native or hls.js", () => {
  const probe = (answer: string): Probe => ({ canPlayType: (t) => (t.toLowerCase().includes("mpegurl") ? answer : "") });

  it("uses native HLS when canPlayType says maybe/probably", () => {
    expect(hlsMode(probe("maybe"), true)).toBe("native");
    expect(hlsMode(probe("probably"), false)).toBe("native");
  });

  it("falls back to hls.js with MSE, else can't play", () => {
    expect(hlsMode(probe(""), true)).toBe("hlsjs");
    expect(hlsMode(probe(""), false)).toBe("none");
    expect(hlsMode(null, true)).toBe("hlsjs");
  });

  it("Android: hls.js over its native HLS (MediaPlayer seeks badly) when MSE exists", () => {
    expect(hlsMode(probe("maybe"), true, true)).toBe("hlsjs");
    expect(hlsMode(probe("maybe"), false, true)).toBe("native");
    expect(isAndroid("Mozilla/5.0 (Linux; Android 11; TX3 Plus Build/RD2A.211001.002; wv) AppleWebKit/537.36")).toBe(true);
    expect(isAndroid("Mozilla/5.0 (SMART-TV; Linux; Tizen 5.5) AppleWebKit/537.36")).toBe(false);
  });

  it("browser badges treat HLS online sources as playable", () => {
    const chrome = detectBrowser("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36");
    const mse: Probe = { canPlayType: () => "", isTypeSupported: () => true };
    const hls = { format: "hls", mime_type: "application/vnd.apple.mpegurl", media_info: null, release: null };
    expect(assessForBrowser(hls, mse, chrome).verdict).toBe("playable");
    // Same MIME type without the format field (older server) also counts.
    expect(assessForBrowser({ ...hls, format: null }, mse, chrome).verdict).toBe("playable");
    const bare: Probe = { canPlayType: () => "" };
    const no = assessForBrowser(hls, bare, chrome);
    expect(no.verdict).toBe("unlikely");
    expect(no.reasons[0]!.code).toBe("hls");
  });
});

describe("quality switch keeps the position", () => {
  it("continues where it was, playing only if it was playing", () => {
    expect(qualityReload({ currentTime: 612.4, paused: false, ended: false }, 0)).toEqual({ at: 612.4, play: true });
    expect(qualityReload({ currentTime: 612.4, paused: true, ended: false }, 0)).toEqual({ at: 612.4, play: false });
    expect(qualityReload({ currentTime: 30, paused: true, ended: true }, 0)).toEqual({ at: 30, play: false });
    expect(qualityReload(null, 90)).toEqual({ at: 90, play: true });
  });

  it("forces a reload when the URL didn't change", () => {
    expect(reloadUrl("/a/index.m3u8", "/b/index.m3u8", 720)).toBe("/a/index.m3u8");
    expect(reloadUrl("/a/index.m3u8", "/a/index.m3u8", 720)).toBe("/a/index.m3u8?q=720");
  });
});

describe("skip markers", () => {
  const m = [{ kind: "opening" as const, start_seconds: 60, end_seconds: 150 }, { kind: "ending" as const, start_seconds: 1300, end_seconds: 1390 }];
  it("finds the opening the position is in", () => {
    expect(activeMarker(m, 59)).toBeNull();
    expect(activeMarker(m, 60)?.end_seconds).toBe(150);
    expect(activeMarker(m, 147)?.kind).toBe("opening");
    expect(activeMarker(m, 149)).toBeNull(); // last 2 s: nothing left to skip
    expect(activeMarker(m, 1310)).toBeNull(); // endings aren't offered by default
    expect(activeMarker(m, 1310, ["ending"])?.kind).toBe("ending");
  });
});

describe("skip targets (intro / recap / credits)", () => {
  const m = [
    { kind: "recap" as const, start_seconds: 0, end_seconds: 40 },
    { kind: "opening" as const, start_seconds: 60, end_seconds: 150 },
    { kind: "ending" as const, start_seconds: 1300, end_seconds: 2200 },
  ];
  it("offers the recap, the intro, and the credits only when allowed", () => {
    expect(skipTarget(m, 10)?.kind).toBe("recap");
    expect(skipTarget(m, 45)).toBeNull();
    expect(skipTarget(m, 100)?.kind).toBe("opening");
    expect(skipTarget(m, 1310)).toBeNull(); // a film, or no next episode
    expect(skipTarget(m, 1310, 1400, true)?.kind).toBe("ending");
  });
  it("clamps an open ending to the duration", () => {
    expect(skipTarget(m, 1399, 1400, true)).toBeNull(); // last 2 s
    expect(skipTarget(m, 1500, 0, true)?.kind).toBe("ending"); // duration unknown
    expect(skipTarget([{ kind: "ending" as const, start_seconds: 1398, end_seconds: 2000 }], 1398, 1400, true)).toBeNull();
  });
  it("auto-skips only right after the range starts", () => {
    expect(autoSkipDue(m[1]!, 61)).toBe(true);
    expect(autoSkipDue(m[1]!, 90)).toBe(false); // resumed / seeked into it
    expect(markerKey(m[1]!)).toBe("opening:60");
  });
  it("normalizes the setting", () => {
    expect(skipMode("auto")).toBe("auto");
    expect(skipMode("off")).toBe("off");
    expect(skipMode(undefined)).toBe("button");
    expect(skipMode("nope")).toBe("button");
  });
});

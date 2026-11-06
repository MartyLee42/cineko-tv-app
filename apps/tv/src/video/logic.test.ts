import { describe, expect, it } from "vitest";
import type { DeviceState, Envelope, PlaybackState } from "@martytv/contracts";
import { CommandProcessor, type CommandHost, type VideoPlayRequest } from "../remote/commands";
import { buildDeviceState, type TvScreen } from "../remote/state";
import { KINOZAL_MENU, PROJECTOR_TEXT, RAIL_FIRST, RAIL_PITCH, TERMINAL_MENU } from "../design/menuOrder";
import { menuItems } from "../design/registry";
import { DESIGNS } from "@martytv/ui";
import { openSection, initialStack, push, sameRoute } from "../catalog/nav";
import {
  ago,
  blockReason,
  compactCount,
  countForm,
  formatDuration,
  parseVideoPlay,
  pickPlay,
  profileQuality,
  progressFraction,
  qualityList,
  reportable,
  resumeAt,
  startPosition,
  stepVideo,
  tabRows,
  videoPlaybackState,
  withoutIds,
  type VideoItem,
} from "./logic";

const VID = "dQw4w9WgXcQ";
const PID = "11111111-2222-4333-8444-555555555555";

function item(id: string, o: Partial<VideoItem> = {}): VideoItem {
  return {
    id,
    title: `Video ${id}`,
    channel_id: "UCuAXFkgsw1L7xaCfnd5JJOw",
    channel_name: "Channel",
    channel_verified: false,
    duration_seconds: 212,
    views: 1234,
    published_at: null,
    published_text: null,
    thumbnail: `/api/v1/video/thumbs/vi/${id}/mqdefault.jpg`,
    thumbnail_hd: `/api/v1/video/thumbs/vi/${id}/hqdefault.jpg`,
    live: false,
    upcoming: false,
    short: false,
    ...o,
  };
}

describe("labels", () => {
  it("formats durations, compact counts and plural forms by hand (old engines lack Intl compact)", () => {
    expect(formatDuration(245)).toBe("4:05");
    expect(formatDuration(3723)).toBe("1:02:03");
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(0)).toBeNull();
    expect(compactCount(950, "ru")).toBe("950");
    expect(compactCount(15_400, "ru")).toBe("15 тыс.");
    expect(compactCount(1_234_567, "ru")).toBe("1,2 млн");
    expect(compactCount(1_234_567, "en")).toBe("1.2M");
    expect(compactCount(3_100_000_000, "en")).toBe("3.1B");
    expect(countForm(1, "ru")).toBe("one");
    expect(countForm(3, "ru")).toBe("few");
    expect(countForm(11, "ru")).toBe("many");
    expect(countForm(22, "ru")).toBe("few");
    expect(countForm(15_000, "ru")).toBe("many");
    expect(countForm(1, "en")).toBe("one");
    expect(countForm(2, "en")).toBe("many");
  });

  it("says how long ago a video was published", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    expect(ago("2026-10-29T11:30:00Z", now)).toEqual({ unit: "now", n: 0 });
    expect(ago("2026-10-29T07:00:00Z", now)).toEqual({ unit: "hours", n: 5 });
    expect(ago("2026-10-26T12:00:00Z", now)).toEqual({ unit: "days", n: 3 });
    expect(ago("2026-10-08T12:00:00Z", now)).toEqual({ unit: "weeks", n: 3 });
    expect(ago("2026-06-01T12:00:00Z", now)).toEqual({ unit: "months", n: 5 });
    expect(ago("2023-10-01T12:00:00Z", now)).toEqual({ unit: "years", n: 3 });
    expect(ago(null, now)).toBeNull();
    expect(ago("nope", now)).toBeNull();
  });
});

describe("progress and resume", () => {
  const p = (position_seconds: number, duration_seconds = 600, finished = false) => ({ position_seconds, duration_seconds, finished, updated_at: "2026-10-29T10:00:00Z" });

  it("draws a bar only for unfinished videos", () => {
    expect(progressFraction(p(300))).toBe(0.5);
    expect(progressFraction(p(1))).toBe(0.02);
    expect(progressFraction(p(300, 600, true))).toBeNull();
    expect(progressFraction(null)).toBeNull();
    expect(progressFraction(p(30, 0), 60)).toBe(0.5);
  });

  it("offers resuming only when worth it", () => {
    expect(resumeAt(p(192))).toBe(192);
    expect(resumeAt(p(10))).toBeNull();
    expect(resumeAt(p(595))).toBeNull();
    expect(resumeAt(p(300, 600, true))).toBeNull();
  });

  it("starts at the explicit position, else the source's, never in the last seconds", () => {
    expect(startPosition(0, 120, 600)).toBe(0);
    expect(startPosition(null, 120, 600)).toBe(120);
    expect(startPosition(undefined, null, 600)).toBe(0);
    expect(startPosition(42, 120, 600)).toBe(42);
    expect(startPosition(598, null, 600)).toBe(0);
  });

  it("reports only sane positions", () => {
    expect(reportable(0.5, 100)).toBe(false);
    expect(reportable(12, 100)).toBe(true);
    expect(reportable(200, 100)).toBe(false);
    expect(reportable(12, null)).toBe(true);
    expect(reportable(NaN, null)).toBe(false);
  });
});

describe("what plays", () => {
  const src = { format: "hls", stream_url: "/api/v1/vstream/t/master.m3u8", fallback_url: "/api/v1/vstream/t/fallback.mp4" };

  it("prefers HLS (native, then hls.js), else the MP4 fallback", () => {
    expect(pickPlay(src, "native", false)).toEqual({ mode: "hls-native", url: src.stream_url });
    expect(pickPlay(src, "hlsjs", false)).toEqual({ mode: "hls-js", url: src.stream_url });
    expect(pickPlay(src, "none", false)).toEqual({ mode: "mp4", url: src.fallback_url });
    expect(pickPlay(src, "hlsjs", true)).toEqual({ mode: "mp4", url: src.fallback_url });
    expect(pickPlay({ ...src, fallback_url: null }, "none", false)).toBeNull();
    expect(pickPlay({ format: "mp4", stream_url: "/x.mp4" }, "none", false)).toEqual({ mode: "mp4", url: "/x.mp4" });
  });

  it("blocks live streams / premieres and unplayable videos", () => {
    expect(blockReason(item(VID, { live: true }))).toBe("live");
    expect(blockReason(item(VID, { upcoming: true }))).toBe("live");
    expect(blockReason({ live: false, upcoming: false, playable: false })).toBe("unplayable");
    expect(blockReason(item(VID))).toBeNull();
  });

  it("lists qualities ≤ 1080 highest first and sanitizes the profile's", () => {
    expect(qualityList([360, 1080, 720, 1440, 720, 480])).toEqual([1080, 720, 480, 360]);
    expect(qualityList(null)).toEqual([]);
    expect(profileQuality(1080)).toBe(1080);
    expect(profileQuality(2160)).toBe(720);
    expect(profileQuality(undefined)).toBe(720);
  });

  it("steps through a list with wrap-around", () => {
    const list = [item("aaaaaaaaaaa"), item("bbbbbbbbbbb"), item("ccccccccccc")];
    expect(stepVideo(list, "ccccccccccc", 1)?.id).toBe("aaaaaaaaaaa");
    expect(stepVideo(list, "aaaaaaaaaaa", -1)?.id).toBe("ccccccccccc");
    expect(stepVideo([list[0]!], "aaaaaaaaaaa", 1)).toBeNull();
  });
});

describe("the tab's rows", () => {
  it("keeps Подписки and В тренде, adds personal rows only when they have videos", () => {
    const a = [item("aaaaaaaaaaa")];
    expect(tabRows({ continue: [], subscriptions: [], trending: a, watch_later: [], history: [] })).toEqual(["subscriptions", "trending"]);
    expect(tabRows({ continue: a, subscriptions: a, trending: a, watch_later: a, history: a })).toEqual(["continue", "subscriptions", "trending", "watch_later", "history"]);
    expect(tabRows({ continue: undefined, subscriptions: undefined, trending: undefined, watch_later: undefined, history: undefined })).toEqual(["subscriptions", "trending"]);
  });

  it("drops videos already in «Продолжить»", () => {
    expect(withoutIds([item("aaaaaaaaaaa"), item("bbbbbbbbbbb")], new Set(["aaaaaaaaaaa"])).map((v) => v.id)).toEqual(["bbbbbbbbbbb"]);
  });

  it("is a menu tab right after «ТВ» in every design, and Кинозал's rail still fits", () => {
    for (const m of [KINOZAL_MENU, TERMINAL_MENU, PROJECTOR_TEXT]) expect(m[m.indexOf("tv") + 1]).toBe("video");
    for (const d of DESIGNS) expect(menuItems(d).filter((x) => x === "video")).toHaveLength(1);
    expect(RAIL_FIRST + KINOZAL_MENU.length * RAIL_PITCH).toBeLessThan(1080 - 36 - 62 - 62);
  });

  it("routes: search and channels stack on the tab; Back returns", () => {
    const s = openSection(initialStack(), { name: "video" });
    const deeper = push(s, { name: "video-channel", id: "UCuAXFkgsw1L7xaCfnd5JJOw", title: "C" });
    expect(deeper.map((e) => e.route.name)).toEqual(["home", "video", "video-channel"]);
    expect(sameRoute({ name: "video-channel", id: "a", title: "x" }, { name: "video-channel", id: "b", title: "x" })).toBe(false);
  });
});

// ---------------------------------------------------------------- remote

const PLAYING: PlaybackState = { media_id: PID, title: "Movie", position_seconds: 10, duration_seconds: 100, paused: false, buffering: false };

function host(screen: TvScreen, o: { playback?: PlaybackState | null; video?: boolean; busy?: boolean } = {}) {
  const calls: VideoPlayRequest[] = [];
  const state = (s: Partial<DeviceState> = {}): DeviceState => ({ screen, profile_id: null, media_id: null, playback: o.playback ?? null, ...s });
  const h: CommandHost = {
    screen: () => screen,
    playback: () => o.playback ?? null,
    state: () => state(),
    open: () => state(),
    queue: () => undefined,
    showMessage: () => undefined,
    play: () => state(),
    queuePlay: () => undefined,
    control: () => state(),
    busy: () => o.busy ?? false,
    ...(o.video === false ? {} : { playVideo: (req: VideoPlayRequest) => (calls.push(req), state({ screen: "player" })) }),
  };
  return { h, calls };
}
const cmd = (payload: unknown, type = "video.play"): Envelope => ({ id: `c-${Math.random()}`, type, payload });

describe("video.play", () => {
  it("validates the payload", () => {
    expect(parseVideoPlay({ video_id: VID })).toEqual({ video_id: VID, force: false });
    expect(parseVideoPlay({ video_id: VID, profile_id: PID.toUpperCase(), position_seconds: 42.5, quality: 1080, force: true })).toEqual({
      video_id: VID,
      profile_id: PID,
      position_seconds: 42.5,
      quality: 1080,
      force: true,
    });
    expect(parseVideoPlay({ video_id: "short" })).toBeNull();
    expect(parseVideoPlay({ video_id: VID, quality: 2160 })).toBeNull();
    expect(parseVideoPlay({ video_id: VID, position_seconds: -1 })).toBeNull();
    expect(parseVideoPlay({ video_id: VID, profile_id: "x" })).toBeNull();
    expect(parseVideoPlay([VID])).toBeNull();
  });

  it("plays; busy_playing over a film or another video unless forced", () => {
    const idle = host("home");
    expect(new CommandProcessor(idle.h).handle(cmd({ video_id: VID, position_seconds: 30, quality: 480 }))?.ok).toBe(true);
    expect(idle.calls).toEqual([{ video_id: VID, position_seconds: 30, quality: 480 }]);

    for (const o of [{ playback: PLAYING }, { busy: true }]) {
      const busy = host("player", o);
      const p = new CommandProcessor(busy.h);
      expect(p.handle(cmd({ video_id: VID }))).toEqual({ ok: false, error: "busy_playing" });
      expect(p.handle(cmd({ video_id: VID, force: true }))?.ok).toBe(true);
      expect(busy.calls).toEqual([{ video_id: VID }]);
    }
  });

  it("a YouTube video playing also makes media.play / iptv.play ask first", () => {
    const p = new CommandProcessor({ ...host("player", { busy: true }).h, playLive: () => host("player").h.state() });
    expect(p.handle(cmd({ media_id: PID }, "media.play"))).toEqual({ ok: false, error: "busy_playing" });
    expect(p.handle(cmd({ channel_id: PID }, "iptv.play"))).toEqual({ ok: false, error: "busy_playing" });
  });

  it("fails on the profile picker, unsupported without the player, bad_payload on garbage", () => {
    expect(new CommandProcessor(host("profiles").h).handle(cmd({ video_id: VID }))).toEqual({ ok: false, error: "failed" });
    expect(new CommandProcessor(host("home", { video: false }).h).handle(cmd({ video_id: VID }))).toEqual({ ok: false, error: "unsupported" });
    expect(new CommandProcessor(host("home").h).handle(cmd({ video_id: 5 }))).toEqual({ ok: false, error: "bad_payload" });
  });

  it("reports the player screen with the video's title while it plays; the tab as Home", () => {
    const video = videoPlaybackState({ id: VID, title: "Rick" }, null);
    const st = buildDeviceState({ screen: "catalog", route: { name: "video" }, profile: { id: "p", name: "Марти" }, video });
    expect(st).toEqual(expect.objectContaining({ screen: "player", media_id: null, playback: null, title: "Rick", profile_id: "p", video }));
    for (const route of [{ name: "video" as const }, { name: "video-search" as const }, { name: "video-channel" as const, id: "UC1", title: "C" }]) {
      expect(buildDeviceState({ screen: "catalog", route, profile: { id: "p", name: "M" } }).screen).toBe("home");
    }
  });
});

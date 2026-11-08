// «Видео» lists on the TV: paging, automatic retries, focus that follows its
// item when a list changes, and the phone remote's commands on the player.
import { describe, expect, it, vi } from "vitest";
import type { VideoItem } from "./logic";
import {
  channelNext,
  dedupeById,
  feedNextOffset,
  fullTabError,
  nextRelated,
  retryDelay,
  searchNextPage,
  SEARCH_PAGES,
  videoPlaybackState,
  wantsMore,
  type VideoPlayerInfo,
} from "./logic";
import { trackedIndex } from "../catalog/virtual";
import { qualityInPlace, videoControl } from "./remote";
import type { VideoControls, VideoSession } from "./session";

const vid = (n: number) => `vid${String(n).padStart(8, "0")}`;
const item = (n: number, o: Partial<VideoItem> = {}): VideoItem => ({
  id: vid(n),
  title: `V${n}`,
  channel_id: "UCabcdefghijklmnopqrstuv",
  channel_name: "C",
  channel_verified: false,
  duration_seconds: 100,
  views: null,
  published_at: null,
  published_text: null,
  thumbnail: `/api/v1/video/thumbs/vi/${vid(n)}/mqdefault.jpg`,
  thumbnail_hd: `/api/v1/video/thumbs/vi/${vid(n)}/hqdefault.jpg`,
  live: false,
  upcoming: false,
  short: false,
  ...o,
});

describe("paging", () => {
  it("feed: next_offset, else done (also for servers without paging)", () => {
    expect(feedNextOffset({ next_offset: 50 })).toBe(50);
    expect(feedNextOffset({ next_offset: null })).toBeUndefined();
    expect(feedNextOffset({})).toBeUndefined();
    expect(feedNextOffset({ next_offset: 0 })).toBeUndefined();
  });

  it("search: the next page until an empty one or the cap", () => {
    expect(searchNextPage({ page: 1, videos: [1] })).toBe(2);
    expect(searchNextPage({ page: 3, videos: [] })).toBeUndefined();
    expect(searchNextPage({ page: SEARCH_PAGES, videos: [1] })).toBeUndefined();
    expect(SEARCH_PAGES).toBeLessThanOrEqual(20); // the server's limit
  });

  it("channel: the continuation token", () => {
    expect(channelNext({ continuation: "abc" })).toBe("abc");
    expect(channelNext({ continuation: null })).toBeUndefined();
    expect(channelNext({ continuation: "" })).toBeUndefined();
  });

  it("loads more near the end only when there is more, nothing in flight and the last try didn't fail", () => {
    const ok = { hasNext: true, fetching: false, failed: false };
    expect(wantsMore(91, 100, ok)).toBe(false);
    expect(wantsMore(92, 100, ok)).toBe(true);
    expect(wantsMore(99, 100, ok)).toBe(true);
    expect(wantsMore(99, 100, { ...ok, hasNext: false })).toBe(false);
    expect(wantsMore(99, 100, { ...ok, fetching: true })).toBe(false);
    // A failed page is retried by the backoff, not by every key press.
    expect(wantsMore(99, 100, { ...ok, failed: true })).toBe(false);
    expect(wantsMore(0, 0, ok)).toBe(false);
    expect(wantsMore(10, 30, ok, 24)).toBe(true);
  });

  it("drops repeats across pages (the feed can shift between pages)", () => {
    expect(dedupeById([item(1), item(2), item(1), item(3), item(2)]).map((v) => v.id)).toEqual([vid(1), vid(2), vid(3)]);
  });
});

describe("errors keep the rows (and focus)", () => {
  it("a failed refetch with cards on screen never swaps the rows for an error", () => {
    expect(fullTabError(false, 2, ["trending"])).toBe(false);
    expect(fullTabError(false, 1, ["subscriptions", "trending", "continue"])).toBe(false);
  });
  it("only an empty tab whose main lists failed shows the full error", () => {
    expect(fullTabError(false, 0, ["trending"])).toBe(true);
    expect(fullTabError(false, 0, ["continue"])).toBe(false);
    expect(fullTabError(true, 0, ["trending"])).toBe(false);
  });
});

describe("automatic retry", () => {
  it("backs off 5 s, 10 s, 20 s, 40 s, then every 60 s", () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(retryDelay)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect(retryDelay(-1)).toBe(5_000);
  });
});

describe("focus follows its item when the list changes", () => {
  const keys = ["a", "b", "c", "d"];
  it("uses the focused key's new index", () => {
    expect(trackedIndex(keys, "c", 0)).toBe(2);
    // New videos in front: the focused one moved right.
    expect(trackedIndex(["x", "y", ...keys], "c", 2)).toBe(4);
  });
  it("falls back to the last index (clamped) when the item is gone — never to the end of a longer list", () => {
    expect(trackedIndex(["a", "b", "d"], "c", 2)).toBe(2);
    expect(trackedIndex(["a"], "c", 2)).toBe(0);
    expect(trackedIndex([], "c", 5)).toBe(0);
    expect(trackedIndex(keys, null, 1)).toBe(1);
  });
});

function controls(o: Partial<VideoControls> = {}): VideoControls & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    pause: () => (calls.push("pause"), true),
    resume: () => (calls.push("resume"), true),
    seek: (p) => (calls.push(`seek:${p}`), true),
    next: () => (calls.push("next"), true),
    quality: (q) => (calls.push(`quality:${q}`), true),
    audio: (id) => (calls.push(`audio:${id}`), true),
    info: () => null,
    ...o,
  };
}

describe("phone remote → the YouTube player", () => {
  it("maps media.pause / resume / seek / stop / next_episode to the player", () => {
    const vc = controls();
    const close = vi.fn();
    expect(videoControl({ type: "pause" }, vc, close)).toBe(true);
    expect(videoControl({ type: "resume" }, vc, close)).toBe(true);
    expect(videoControl({ type: "seek", position_seconds: 95 }, vc, close)).toBe(true);
    expect(videoControl({ type: "next_episode" }, vc, close)).toBe(true);
    expect(vc.calls).toEqual(["pause", "resume", "seek:95", "next"]);
    expect(videoControl({ type: "stop" }, vc, close)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("stop works even before the player is mounted; the rest fail; tracks/sources are unsupported", () => {
    const close = vi.fn();
    expect(videoControl({ type: "stop" }, null, close)).toBe(true);
    expect(videoControl({ type: "pause" }, null, close)).toBe("failed");
    expect(videoControl({ type: "seek", position_seconds: 1 }, controls({ seek: () => false }), close)).toBe("failed");
    expect(videoControl({ type: "next_episode" }, controls({ next: () => false }), close)).toBe("failed");
    expect(videoControl({ type: "set_subtitles", track_id: "a" }, controls(), close)).toBe("unsupported");
    expect(videoControl({ type: "select_source", source_id: "s" }, controls(), close)).toBe("unsupported");
  });

  it("set_audio switches an auto-dub's language; an unknown track fails", () => {
    const vc = controls({ audio: (id) => id === "ru" });
    const close = vi.fn();
    expect(videoControl({ type: "set_audio", track_id: "ru" }, vc, close)).toBe(true);
    expect(videoControl({ type: "set_audio", track_id: "xx" }, vc, close)).toBe("failed");
    expect(videoControl({ type: "set_audio", track_id: "ru" }, null, close)).toBe("failed");
  });

  it("video.play of the video on screen with a quality switches in place; anything else starts a video", () => {
    const vc = controls();
    const cur: VideoSession = { video: { id: vid(1) }, start: null, quality: null, seq: 1 };
    expect(qualityInPlace({ video_id: vid(1), quality: 1080 }, cur, vc)).toBe(true);
    expect(vc.calls).toEqual(["quality:1080"]);
    expect(qualityInPlace({ video_id: vid(2), quality: 1080 }, cur, vc)).toBeNull();
    expect(qualityInPlace({ video_id: vid(1) }, cur, vc)).toBeNull();
    expect(qualityInPlace({ video_id: vid(1), quality: 720 }, null, vc)).toBeNull();
    expect(qualityInPlace({ video_id: vid(1), quality: 720 }, cur, controls({ quality: () => false }))).toBe(false);
  });

  it("«Следующее видео»: the first playable related one", () => {
    expect(nextRelated([item(1), item(2, { live: true }), item(3)], vid(1))?.id).toBe(vid(3));
    expect(nextRelated([item(2, { upcoming: true })], vid(1))).toBeNull();
  });
});

describe("DeviceState.video", () => {
  const info: VideoPlayerInfo = {
    title: "Оригинальное название",
    channel_id: "UCabcdefghijklmnopqrstuv",
    channel_name: "Едим ТВ",
    position: 61.7,
    duration: 600.04,
    paused: true,
    buffering: false,
    quality: 720,
    qualities: [1080, 720, 480],
    volume: 0.456,
    error: null,
  };

  it("the player's live values over the card it was opened from", () => {
    expect(videoPlaybackState(item(1, { title: "Translated" }), info)).toEqual({
      video_id: vid(1),
      title: "Оригинальное название",
      channel_id: "UCabcdefghijklmnopqrstuv",
      channel_name: "Едим ТВ",
      thumbnail: `/api/v1/video/thumbs/vi/${vid(1)}/mqdefault.jpg`,
      position_seconds: 61,
      duration_seconds: 600,
      paused: true,
      buffering: false,
      quality: 720,
      qualities: [1080, 720, 480],
      volume: 0.46,
      error: null,
    });
  });

  it("before the player is up (sent by id from a phone): loading, thumbnail from the id", () => {
    expect(videoPlaybackState({ id: vid(2) }, null)).toEqual(
      expect.objectContaining({ video_id: vid(2), title: null, thumbnail: `/api/v1/video/thumbs/vi/${vid(2)}/mqdefault.jpg`, position_seconds: 0, buffering: true, paused: false, qualities: [] }),
    );
  });

  it("an auto-dub's languages for the phone's «Аудио» list (none for one track)", () => {
    const tracks = [
      { id: "en", label: "Оригинал · Английский", language: "en" },
      { id: "ru", label: "Русский дубляж", language: "ru" },
    ];
    expect(videoPlaybackState({ id: vid(1) }, { ...info, audio_tracks: tracks, audio_track: "ru" })).toEqual(
      expect.objectContaining({
        audio_tracks: [
          { id: "en", label: "Оригинал · Английский", language: "en" },
          { id: "ru", label: "Русский дубляж", language: "ru" },
        ],
        audio_track_id: "ru",
      }),
    );
    expect(videoPlaybackState({ id: vid(1) }, { ...info, audio_tracks: tracks.slice(0, 1), audio_track: "en" })).not.toHaveProperty("audio_tracks");
  });

  it("whole seconds, so a paused video's state isn't re-sent", () => {
    const a = videoPlaybackState({ id: vid(1) }, { ...info, position: 61.1 });
    const b = videoPlaybackState({ id: vid(1) }, { ...info, position: 61.9 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

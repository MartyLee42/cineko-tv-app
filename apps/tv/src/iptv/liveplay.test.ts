// Shared live playback decisions (@martytv/media-types livePlay.ts).
import { describe, expect, it } from "vitest";
import { apiErrorCode, liveCodecProblem, liveEngines, liveFailureFromCode, mseTypeSupported, workingGroups } from "@martytv/media-types";

const probe = (types: Record<string, string>) => ({ canPlayType: (t: string) => types[t] ?? "" });
const samsung = probe({ "application/vnd.apple.mpegurl": "maybe", "video/mp2t": "maybe" });
const chrome = probe({});

describe("liveEngines", () => {
  it("HLS: native first on TVs, hls.js as the fallback", () => {
    expect(liveEngines("hls", samsung, true)).toEqual(["native", "hlsjs"]);
    expect(liveEngines("hls", samsung, false)).toEqual(["native"]);
  });
  it("HLS: hls.js in desktop browsers and first on Android", () => {
    expect(liveEngines("hls", chrome, true)).toEqual(["hlsjs"]);
    expect(liveEngines("hls", samsung, true, true)).toEqual(["hlsjs", "native"]);
    expect(liveEngines("hls", chrome, false)).toEqual([]);
  });
  it("MPEG-TS: native where <video> plays it, else mpegts.js (no src=stream.ts in Chrome)", () => {
    expect(liveEngines("ts", samsung, true)).toEqual(["native", "mpegts"]);
    expect(liveEngines("ts", chrome, true)).toEqual(["mpegts"]);
    expect(liveEngines("ts", chrome, false)).toEqual([]);
  });
  it("survives a throwing canPlayType", () => {
    expect(liveEngines("hls", { canPlayType: () => { throw new Error("x"); } }, true)).toEqual(["hlsjs"]);
  });
});

describe("liveCodecProblem", () => {
  const none = () => false;
  const all = () => true;
  it("MPEG-2 never plays through MSE", () => {
    expect(liveCodecProblem({ video_codec: "mpeg2", audio_codec: "mp2" }, all)).toBe("mpeg2");
  });
  it("HEVC / AC-3 / E-AC-3 depend on the browser", () => {
    expect(liveCodecProblem({ video_codec: "h264", audio_codec: "ac3" }, none)).toBe("ac3");
    expect(liveCodecProblem({ video_codec: "h264", audio_codec: "ac3" }, all)).toBeNull();
    expect(liveCodecProblem({ video_codec: "hevc", audio_codec: "aac" }, (t) => !t.includes("hvc1"))).toBe("hevc");
    expect(liveCodecProblem({ video_codec: "h264", audio_codec: "eac3" }, null)).toBe("eac3");
  });
  it("unknown or common codecs are fine", () => {
    expect(liveCodecProblem({ video_codec: "h264", audio_codec: "aac" }, none)).toBeNull();
    expect(liveCodecProblem({}, none)).toBeNull();
  });
  it("reads MediaSource.isTypeSupported", () => {
    const f = mseTypeSupported({ MediaSource: { isTypeSupported: (t: string) => t.includes("ac-3") } });
    expect(f?.('audio/mp4; codecs="ac-3"')).toBe(true);
    expect(mseTypeSupported({})).toBeNull();
  });
});

describe("live failures", () => {
  it("maps API error codes to messages", () => {
    expect(liveFailureFromCode("channel_geo_blocked")).toBe("geo");
    expect(liveFailureFromCode("channel_timeout")).toBe("timeout");
    expect(liveFailureFromCode("channel_format_unsupported")).toBe("format");
    expect(liveFailureFromCode("channel_unavailable")).toBe("offline");
    expect(liveFailureFromCode(null)).toBe("broken");
    expect(liveFailureFromCode("internal")).toBe("broken");
  });
  it("reads the code of an ApiError", () => {
    expect(apiErrorCode({ code: "channel_timeout", status: 502 })).toBe("channel_timeout");
    expect(apiErrorCode(new Error("x"))).toBeNull();
    expect(apiErrorCode(null)).toBeNull();
  });
  it("recounts groups over working channels", () => {
    const g = workingGroups(
      [
        { id: "news", name: "N", count: 2 },
        { id: "kids", name: "K", count: 1 },
      ],
      [
        { group_id: "news", offline: false },
        { group_id: "news", offline: true },
        { group_id: "kids", offline: true },
      ],
    );
    expect(g).toEqual([{ id: "news", name: "N", count: 1 }]);
  });
});

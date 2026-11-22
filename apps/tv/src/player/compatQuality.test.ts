import { describe, expect, it } from "vitest";
import { compatSrc, scaleChoices } from "./compat";
import { parseControl } from "../remote/commands";

describe("picked quality (torrent, compat h=)", () => {
  it("offers only heights below the file's own, for files the server can decode", () => {
    expect(scaleChoices({ width: 1920, height: 1080 })).toEqual([720, 480, 360]);
    expect(scaleChoices({ width: 1920, height: 800 })).toEqual([720, 480, 360]);
    expect(scaleChoices({ width: 1024, height: 428 })).toEqual([360]);
    expect(scaleChoices({ width: 640, height: 352 })).toEqual([]);
    expect(scaleChoices({ width: 3840, height: 2160 })).toEqual([]); // 4K: too heavy to decode on the server
    expect(scaleChoices(null)).toEqual([]);
  });

  it("puts the height and the reason in the compat URL", () => {
    expect(compatSrc("/s/t/compat.mp4", { audio: 1, start: 12.5, height: 480, why: "quality" })).toBe("/s/t/compat.mp4?audio=1&start=12.5&h=480&why=quality");
    expect(compatSrc("/s/t/compat.mp4", { audio: null, start: 0, why: "starve" })).toBe("/s/t/compat.mp4?why=starve");
    expect(compatSrc("/s/t/compat.mp4", { audio: null, start: 0 })).toBe("/s/t/compat.mp4");
  });

  it("parses playback.set_quality from the phone", () => {
    expect(parseControl("playback.set_quality", { track_id: "480" })).toEqual({ type: "set_quality", quality: 480 });
    expect(parseControl("playback.set_quality", { track_id: "0" })).toEqual({ type: "set_quality", quality: 0 });
    expect(parseControl("playback.set_quality", { track_id: "high" })).toBeNull();
    expect(parseControl("playback.set_quality", {})).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { DeviceState, PlayerKind } from "@martytv/contracts";
import { playReducer, PLAY_IDLE, type PlayRequest } from "./flow";
import {
  absoluteStreamUrl,
  decidePlayer,
  detectPlatform,
  intentUrl,
  localOptions,
  m3u,
  orderLocalOptions,
  safeName,
  streamFileName,
  vlcUrl,
} from "./players";

const st = (players?: PlayerKind[], default_player?: PlayerKind | null): DeviceState => ({
  screen: "home",
  profile_id: null,
  media_id: null,
  playback: null,
  players,
  default_player,
});

describe("TV player decision", () => {
  it("never asks for single-player or older TVs", () => {
    expect(decidePlayer(st(undefined), null)).toEqual({ kind: "use", player: undefined });
    expect(decidePlayer(st(["builtin"]), "msx")).toEqual({ kind: "use", player: "builtin" });
    expect(decidePlayer(null, null, { force: true })).toEqual({ kind: "use", player: undefined });
  });

  it("uses the TV default unless the user asked to choose", () => {
    expect(decidePlayer(st(["builtin", "msx"], "msx"), "builtin")).toEqual({ kind: "use", player: "msx" });
    expect(decidePlayer(st(["builtin", "msx"], "msx"), "builtin", { force: true })).toEqual({
      kind: "ask",
      options: ["builtin", "msx"],
      preselected: "msx",
    });
  });

  it("asks without a default, preselecting the last choice for that TV", () => {
    expect(decidePlayer(st(["external", "builtin", "msx"], null), "external")).toEqual({
      kind: "ask",
      options: ["builtin", "msx", "external"],
      preselected: "external",
    });
    // Remembered player the TV no longer has → first option.
    expect(decidePlayer(st(["builtin", "msx"], null), "external")).toMatchObject({ preselected: "builtin" });
    // A default the TV doesn't list is ignored.
    expect(decidePlayer(st(["builtin", "msx"], "external"), null)).toMatchObject({ kind: "ask", preselected: "builtin" });
  });

  it("an explicit player wins", () => {
    expect(decidePlayer(st(["builtin", "msx"], null), null, { requested: "msx" })).toEqual({ kind: "use", player: "msx" });
  });

  it("flow: ask step, then the chosen player rides on the request", () => {
    const req: PlayRequest = { media_id: "m", label: "x", release_id: "r" };
    let f = playReducer(PLAY_IDLE, {
      type: "request",
      req,
      choice: { kind: "auto", deviceId: "tv" },
      player: { kind: "ask", options: ["builtin", "msx"], preselected: "msx" },
    });
    expect(f).toMatchObject({ step: "player", deviceId: "tv", preselected: "msx" });
    expect(playReducer(f, { type: "cancel" })).toBe(PLAY_IDLE);
    f = playReducer(f, { type: "player", player: "msx" });
    expect(f).toMatchObject({ step: "sending", req: { player: "msx" } });
    // From the TV picker, with a TV default.
    const picking = playReducer(PLAY_IDLE, { type: "request", req, choice: { kind: "pick", preferred: null } });
    expect(playReducer(picking, { type: "pick", deviceId: "a", player: { kind: "use", player: "builtin" } })).toMatchObject({
      step: "sending",
      deviceId: "a",
      req: { player: "builtin" },
    });
  });
});

describe("players on this device", () => {
  const ua = {
    android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36",
    iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
    ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
    win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36",
  };

  it("detects the platform", () => {
    expect(detectPlatform(ua.android)).toBe("android");
    expect(detectPlatform(ua.iphone)).toBe("ios");
    expect(detectPlatform(ua.ipad, 5)).toBe("ios");
    expect(detectPlatform(ua.ipad, 0)).toBe("desktop");
    expect(detectPlatform(ua.win)).toBe("desktop");
  });

  it("offers only what works on the platform", () => {
    expect(localOptions("android")).toEqual(["vlc", "intent", "m3u", "copy"]);
    expect(localOptions("ios")).toEqual(["vlc", "m3u", "copy"]);
    expect(localOptions("desktop")).toEqual(["m3u", "copy"]);
  });

  it("puts the account default first when it is available", () => {
    expect(orderLocalOptions("android", "intent")).toEqual({ primary: "intent", rest: ["vlc", "m3u", "copy"] });
    expect(orderLocalOptions("ios", "intent")).toEqual({ primary: null, rest: ["vlc", "m3u", "copy"] });
    expect(orderLocalOptions("desktop", "ask").primary).toBeNull();
    expect(orderLocalOptions("desktop", "m3u")).toEqual({ primary: "m3u", rest: ["copy"] });
    // A saved "vlc" default from before doesn't apply on computers.
    expect(orderLocalOptions("desktop", "vlc")).toEqual({ primary: null, rest: ["m3u", "copy"] });
  });

  it("builds stream URLs and hand-off links", () => {
    const name = streamFileName({ file: { index: 0, path: "Dune.2024/Дюна 2 [1080p].mkv", size_bytes: 1, is_video: true }, mime_type: null }, "x");
    expect(name).toBe("Дюна 2 [1080p].mkv");
    expect(streamFileName({ file: null, mime_type: "video/mp4" }, "Дюна: Часть 2")).toBe("Дюна Часть 2.mp4");
    expect(streamFileName({ file: null, mime_type: null }, "")).toBe("video.mkv");
    const url = absoluteStreamUrl("/api/v1/stream/tok", "a b.mkv", "http://192.168.1.5:8080");
    expect(url).toBe("http://192.168.1.5:8080/api/v1/stream/tok/a%20b.mkv");
    expect(absoluteStreamUrl("https://tv.example/api/v1/stream/tok/", "f.mp4", "http://x")).toBe("https://tv.example/api/v1/stream/tok/f.mp4");
    expect(vlcUrl(url)).toBe(`vlc://${url}`);
    expect(intentUrl(url, "Дюна")).toBe(
      `intent:${url}#Intent;action=android.intent.action.VIEW;type=video/*;S.title=%D0%94%D1%8E%D0%BD%D0%B0;end`,
    );
    expect(m3u(url, "Дюна\n2")).toBe(`#EXTM3U\n#EXTINF:-1,Дюна 2\n${url}\n`);
    expect(safeName('a/b:c*"?')).toBe("a b c");
  });
});

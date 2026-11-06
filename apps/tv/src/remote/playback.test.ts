import { describe, expect, it } from "vitest";
import type { DeviceState, Envelope, PlaybackState } from "@martytv/contracts";
import { CommandProcessor, parseControl, parsePlay, PLAYBACK_COMMANDS, type CommandHost, type PlayerCommand, type PlayRequest } from "./commands";
import { buildDeviceState, type TvScreen } from "./state";
import { availablePlayers, absoluteStreamUrl, intentUrl, resolvePlayer, streamFileName } from "../players/select";
import { heartbeat, isAlive, matchAck } from "../players/msx";

const MOVIE = "11111111-2222-4333-8444-555555555555";
const EP = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const FROM = { user_id: "u1", username: "alex", display_name: "Alex" };

const PLAYING: PlaybackState = { media_id: MOVIE, title: "Movie", position_seconds: 10, duration_seconds: 100, paused: false, buffering: false };

function host(screen: TvScreen, playback: PlaybackState | null = null, controlResult: DeviceState | "failed" | "unsupported" | null = null) {
  const calls = { play: [] as PlayRequest[], queued: [] as PlayRequest[], control: [] as PlayerCommand[] };
  const state = (s: Partial<DeviceState> = {}): DeviceState => ({ screen, profile_id: null, media_id: null, playback, ...s });
  const h: CommandHost = {
    screen: () => screen,
    playback: () => playback,
    state: () => state(),
    open: () => state({ screen: "details" }),
    queue: () => undefined,
    showMessage: () => undefined,
    play: (req) => {
      calls.play.push(req);
      if (req.player === "msx") return "unsupported";
      return state({ screen: "player", media_id: req.media_id, playback: { ...PLAYING, media_id: req.media_id, buffering: true } });
    },
    queuePlay: (req) => calls.queued.push(req),
    control: (cmd) => {
      calls.control.push(cmd);
      return controlResult ?? state({ screen: "player", playback: { ...PLAYING, paused: cmd.type === "pause" } });
    },
  };
  return { h, calls };
}

const cmd = (type: string, payload?: unknown, id = `c-${Math.random()}`): Envelope => ({ id, type, payload, from: FROM });

describe("media.play", () => {
  it("starts playback and acks with the new state", () => {
    const { h, calls } = host("details");
    const ack = new CommandProcessor(h).handle(cmd("media.play", { media_id: MOVIE, source_id: "src-1", position_seconds: 42 }));
    expect(ack).toEqual({ ok: true, result: expect.objectContaining({ screen: "player", media_id: MOVIE }) });
    expect(calls.play).toEqual([{ media_id: MOVIE, source_id: "src-1", position_seconds: 42 }]);
  });

  it("is busy_playing while playing, unless forced (force isn't passed on)", () => {
    const { h, calls } = host("player", PLAYING);
    const p = new CommandProcessor(h);
    expect(p.handle(cmd("media.play", { media_id: MOVIE }))).toEqual({ ok: false, error: "busy_playing" });
    expect(calls.play).toEqual([]);
    expect(p.handle(cmd("media.play", { media_id: MOVIE, episode_id: EP, force: true }))?.ok).toBe(true);
    expect(calls.play).toEqual([{ media_id: MOVIE, episode_id: EP }]);
  });

  it("replaces a playback still loading without asking (another release from the phone)", () => {
    const { h, calls } = host("player", { ...PLAYING, position_seconds: 0, buffering: true, source_id: "src-1" });
    h.loading = () => true;
    const p = new CommandProcessor(h);
    expect(p.handle(cmd("media.play", { media_id: MOVIE, source_id: "src-2" }))?.ok).toBe(true);
    expect(calls.play).toEqual([{ media_id: MOVIE, source_id: "src-2" }]);
    // Open / live / video still ask: only a new media.play replaces the loading screen.
    expect(p.handle(cmd("media.open", { media_id: MOVIE }))).toEqual({ ok: false, error: "busy_playing" });
  });

  it("queues on the profile picker and fails before sign-in", () => {
    const { h, calls } = host("profiles");
    expect(new CommandProcessor(h).handle(cmd("media.play", { media_id: MOVIE }))).toEqual({ ok: true, result: { queued: true } });
    expect(calls.queued).toEqual([{ media_id: MOVIE }]);
    for (const s of ["boot", "pairing", "offline", "token"] as const) {
      expect(new CommandProcessor(host(s).h).handle(cmd("media.play", { media_id: MOVIE }))).toEqual({ ok: false, error: "failed" });
    }
  });

  it("an unavailable player is unsupported", () => {
    const { h } = host("home");
    expect(new CommandProcessor(h).handle(cmd("media.play", { media_id: MOVIE, player: "msx" }))).toEqual({ ok: false, error: "unsupported" });
  });

  it("validates the payload", () => {
    const bad = [
      null,
      {},
      { media_id: "x" },
      { media_id: MOVIE, episode_id: "nope" },
      { media_id: MOVIE, source_id: "" },
      { media_id: MOVIE, source_id: "x".repeat(129) },
      { media_id: MOVIE, position_seconds: -1 },
      { media_id: MOVIE, position_seconds: "10" },
      { media_id: MOVIE, force: 1 },
      { media_id: MOVIE, player: "vlc" },
    ];
    for (const payload of bad) {
      const { h, calls } = host("home");
      expect(new CommandProcessor(h).handle(cmd("media.play", payload))).toEqual({ ok: false, error: "bad_payload" });
      expect(calls.play).toEqual([]);
    }
    expect(parsePlay({ media_id: MOVIE.toUpperCase(), episode_id: null, player: "builtin", extra: 1 })).toEqual({ media_id: MOVIE, force: false, player: "builtin" });
  });

  it("passes a release chosen on the phone through to the TV (it prepares the source itself)", () => {
    const { h, calls } = host("home");
    const ack = new CommandProcessor(h).handle(cmd("media.play", { media_id: MOVIE, release_id: "rel-1080", quality: 720, position_seconds: 42 }));
    expect(ack?.ok).toBe(true);
    expect(calls.play).toEqual([{ media_id: MOVIE, release_id: "rel-1080", quality: 720, position_seconds: 42 }]);
    expect(parsePlay({ media_id: MOVIE, release_id: "" })).toBeNull();
    expect(parsePlay({ media_id: MOVIE, release_id: "r", quality: 0 })).toBeNull();
    expect(parsePlay({ media_id: MOVIE, release_id: "r", quality: 1.5 })).toBeNull();
  });

  it("a retried id isn't started twice", () => {
    const { h, calls } = host("home");
    const p = new CommandProcessor(h);
    const a = p.handle(cmd("media.play", { media_id: MOVIE }, "same"));
    const b = p.handle(cmd("media.play", { media_id: MOVIE }, "same"));
    expect(b).toBe(a);
    expect(calls.play).toHaveLength(1);
  });
});

describe("playback controls", () => {
  it("covers every playback command", () => {
    expect(PLAYBACK_COMMANDS).toContain("media.select_source");
  });

  it("parses control payloads", () => {
    expect(parseControl("media.pause", undefined)).toEqual({ type: "pause" });
    expect(parseControl("media.seek", { position_seconds: 90.5 })).toEqual({ type: "seek", position_seconds: 90.5 });
    expect(parseControl("media.seek", { position_seconds: -3 })).toBeNull();
    expect(parseControl("media.seek", {})).toBeNull();
    expect(parseControl("media.select_source", { source_id: "s2" })).toEqual({ type: "select_source", source_id: "s2" });
    expect(parseControl("playback.set_audio", { track_id: "a1" })).toEqual({ type: "set_audio", track_id: "a1" });
    expect(parseControl("playback.set_audio", { track_id: null })).toBeNull();
    expect(parseControl("playback.set_subtitles", { track_id: null })).toEqual({ type: "set_subtitles", track_id: null });
    expect(parseControl("playback.set_subtitles", {})).toBeNull();
  });

  it("acks with the new state, or the host's error", () => {
    const { h, calls } = host("player", PLAYING);
    const p = new CommandProcessor(h);
    expect(p.handle(cmd("media.pause"))).toEqual({ ok: true, result: expect.objectContaining({ playback: expect.objectContaining({ paused: true }) }) });
    expect(p.handle(cmd("media.seek", { position_seconds: 30 }))?.ok).toBe(true);
    expect(p.handle(cmd("media.seek", { position_seconds: "x" }))).toEqual({ ok: false, error: "bad_payload" });
    expect(calls.control.map((c) => c.type)).toEqual(["pause", "seek"]);

    const unsupported = host("player", PLAYING, "unsupported");
    expect(new CommandProcessor(unsupported.h).handle(cmd("playback.set_audio", { track_id: "a1" }))).toEqual({ ok: false, error: "unsupported" });
    const nothing = host("details", null, "failed");
    expect(new CommandProcessor(nothing.h).handle(cmd("media.next_episode"))).toEqual({ ok: false, error: "failed" });
  });

  it("controls fail outside the signed-in area", () => {
    const { h, calls } = host("pairing");
    expect(new CommandProcessor(h).handle(cmd("media.stop"))).toEqual({ ok: false, error: "failed" });
    expect(calls.control).toEqual([]);
  });
});

describe("device state while playing", () => {
  it("reports the player screen, playback and players", () => {
    const s = buildDeviceState({
      screen: "catalog",
      route: { name: "details", id: MOVIE },
      profile: { id: "p", name: "Alex" },
      playback: PLAYING,
      player: { media_id: MOVIE, kind: "movie", title: "Movie", poster_path: null, season_number: null },
      players: { available: ["builtin", "msx"], default: null },
    });
    expect(s).toEqual({
      screen: "player",
      media_id: MOVIE,
      kind: "movie",
      title: "Movie",
      poster_path: null,
      season_number: null,
      profile_id: "p",
      profile_name: "Alex",
      playback: PLAYING,
      players: ["builtin", "msx"],
      default_player: null,
    });
  });
});

describe("player selection", () => {
  it("lists available players", () => {
    expect(availablePlayers({ platform: "tizen", msxAlive: false })).toEqual(["builtin"]);
    expect(availablePlayers({ platform: "tizen", msxAlive: true })).toEqual(["builtin", "msx"]);
    expect(availablePlayers({ platform: "android-tv", msxAlive: false })).toEqual(["builtin", "external"]);
  });

  it("resolves requested, default, only-one and ask", () => {
    const all = ["builtin", "msx"] as const;
    expect(resolvePlayer("msx", null, all)).toEqual({ player: "msx" });
    expect(resolvePlayer("external", "builtin", all)).toEqual({ error: "unsupported" });
    expect(resolvePlayer(undefined, "msx", all)).toEqual({ player: "msx" });
    expect(resolvePlayer(undefined, "msx", ["builtin"])).toEqual({ player: "builtin" });
    expect(resolvePlayer(undefined, null, ["builtin"])).toEqual({ player: "builtin" });
    expect(resolvePlayer(undefined, null, all)).toEqual({ ask: true });
    expect(resolvePlayer(undefined, "external", all)).toEqual({ ask: true });
  });

  it("builds stream URLs with a file name and Android intents", () => {
    const src = { stream_url: "/api/v1/stream/tok", mime_type: "video/x-matroska", file: { index: 0, path: "Show/S01/Show S01E02 [1080p].mkv", size_bytes: 1, is_video: true } };
    expect(streamFileName(src)).toBe("Show S01E02 [1080p].mkv");
    expect(streamFileName({ mime_type: "video/mp4", file: null })).toBe("video.mp4");
    const url = absoluteStreamUrl(src, "http://tv.lan:8080");
    expect(url).toBe("http://tv.lan:8080/api/v1/stream/tok/Show%20S01E02%20%5B1080p%5D.mkv");
    expect(absoluteStreamUrl({ ...src, stream_url: null }, "x")).toBeNull();
    expect(intentUrl("http://tv.lan:8080/api/v1/stream/tok/a.mkv", "Show — S01E02", "video/x-matroska", "vlc")).toBe(
      "intent://tv.lan:8080/api/v1/stream/tok/a.mkv#Intent;scheme=http;action=android.intent.action.VIEW;type=video/x-matroska;S.title=Show%20%E2%80%94%20S01E02;package=org.videolan.vlc;end",
    );
    expect(intentUrl("https://h/x", "T", null)).toBe("intent://h/x#Intent;scheme=https;action=android.intent.action.VIEW;type=video/*;S.title=T;end");
  });

  it("reads the MSX bridge heartbeat and acks", () => {
    expect(heartbeat('{"alive_at":1000}')).toBe(1000);
    expect(heartbeat("nope")).toBeNull();
    expect(heartbeat(null)).toBeNull();
    expect(isAlive('{"alive_at":1000}', 10_000)).toBe(true);
    expect(isAlive('{"alive_at":1000}', 20_000)).toBe(false);
    expect(isAlive('{"alive_at":"1000"}', 1000)).toBe(false);
    expect(matchAck({ type: "ack", id: "x", ok: true }, "x")).toEqual({ ok: true });
    expect(matchAck('{"type":"ack","id":"x","ok":false,"error":"no_player"}', "x")).toEqual({ ok: false, error: "no_player" });
    expect(matchAck({ type: "ack", id: "y", ok: true }, "x")).toBeNull();
    expect(matchAck({ type: "play", id: "x" }, "x")).toBeNull();
  });
});

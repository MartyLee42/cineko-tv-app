import { describe, expect, it } from "vitest";
import type { DeviceState, Envelope, PlaybackState } from "@martytv/contracts";
import { CommandProcessor, parseOpen, senderName, type CommandHost, type OpenRequest } from "./commands";
import { buildDeviceState, type TvScreen } from "./state";
import { entry, initialStack, openDetails, pop } from "../catalog/nav";
import { episodeIndex, pickSeason } from "../catalog/seasons";

const MOVIE = "11111111-2222-4333-8444-555555555555";
const SERIES = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const FROM = { user_id: "u1", username: "alex", display_name: "Alex" };

const PLAYING: PlaybackState = {
  media_id: MOVIE,
  title: "Something",
  position_seconds: 10,
  duration_seconds: 100,
  paused: false,
  buffering: false,
};

function fakeHost(screen: TvScreen, playback: PlaybackState | null = null) {
  const calls = { open: [] as OpenRequest[], queue: [] as OpenRequest[], messages: [] as string[], senders: [] as (string | null)[] };
  const state = (s: Partial<DeviceState> = {}): DeviceState => ({ screen, profile_id: null, media_id: null, playback, ...s });
  const host: CommandHost & { screenNow: TvScreen } = {
    screenNow: screen,
    screen: () => host.screenNow,
    playback: () => playback,
    state: () => state({ screen: host.screenNow }),
    open: (req, sender) => {
      calls.open.push(req);
      calls.senders.push(sender);
      host.screenNow = "details";
      return state({ screen: "details", media_id: req.media_id, season_number: req.season_number ?? null });
    },
    queue: (req, sender) => {
      calls.queue.push(req);
      calls.senders.push(sender);
    },
    showMessage: (text, sender) => {
      calls.messages.push(text);
      calls.senders.push(sender);
    },
    play: () => state({ screen: "player" }),
    queuePlay: () => undefined,
    control: () => "failed",
  };
  return { host, calls };
}

const cmd = (type: string, payload?: unknown, id = `c-${Math.random()}`): Envelope => ({ id, type, payload, from: FROM });

describe("media.open", () => {
  it("opens Details when a profile is active and returns the new state", () => {
    const { host, calls } = fakeHost("home");
    const ack = new CommandProcessor(host).handle(cmd("media.open", { media_id: MOVIE }));
    expect(ack).toEqual({ ok: true, result: expect.objectContaining({ screen: "details", media_id: MOVIE }) });
    expect(calls.open).toEqual([{ media_id: MOVIE }]);
    expect(calls.senders).toEqual(["Alex"]);
  });

  it("works from every catalog screen", () => {
    for (const s of ["home", "search", "browse", "details"] as const) {
      const { host } = fakeHost(s);
      expect(new CommandProcessor(host).handle(cmd("media.open", { media_id: MOVIE }))?.ok).toBe(true);
    }
  });

  it("queues on the profile picker (latest wins is the host's job)", () => {
    const { host, calls } = fakeHost("profiles");
    const ack = new CommandProcessor(host).handle(cmd("media.open", { media_id: SERIES, season_number: 2 }));
    expect(ack).toEqual({ ok: true, result: { queued: true } });
    expect(calls.queue).toEqual([{ media_id: SERIES, season_number: 2 }]);
    expect(calls.open).toEqual([]);
  });

  it("fails while booting, offline or pairing", () => {
    for (const s of ["boot", "offline", "pairing", "token"] as const) {
      const { host, calls } = fakeHost(s);
      expect(new CommandProcessor(host).handle(cmd("media.open", { media_id: MOVIE }))).toEqual({ ok: false, error: "failed" });
      expect(calls.open).toEqual([]);
    }
  });

  it("refuses to interrupt playback unless forced", () => {
    const { host, calls } = fakeHost("player", PLAYING);
    const p = new CommandProcessor(host);
    expect(p.handle(cmd("media.open", { media_id: MOVIE }))).toEqual({ ok: false, error: "busy_playing" });
    expect(calls.open).toEqual([]);
    expect(p.handle(cmd("media.open", { media_id: MOVIE, force: true }))?.ok).toBe(true);
    // force is not passed on to the navigation.
    expect(calls.open).toEqual([{ media_id: MOVIE }]);
  });

  it("passes season and episode through", () => {
    const { host, calls } = fakeHost("home");
    new CommandProcessor(host).handle(cmd("media.open", { media_id: SERIES, season_number: 2, episode_number: 5 }));
    expect(calls.open).toEqual([{ media_id: SERIES, season_number: 2, episode_number: 5 }]);
  });

  it("rejects bad payloads", () => {
    const bad = [
      undefined,
      null,
      "x",
      [],
      {},
      { media_id: "not-a-uuid" },
      { media_id: 42 },
      { media_id: MOVIE, season_number: -1 },
      { media_id: MOVIE, season_number: 1.5 },
      { media_id: MOVIE, season_number: "2" },
      { media_id: MOVIE, episode_number: 3 },
      { media_id: MOVIE, season_number: 1, episode_number: 0 },
      { media_id: MOVIE, force: "yes" },
    ];
    for (const payload of bad) {
      const { host, calls } = fakeHost("home");
      expect(new CommandProcessor(host).handle(cmd("media.open", payload))).toEqual({ ok: false, error: "bad_payload" });
      expect(calls.open).toEqual([]);
    }
    expect(parseOpen({ media_id: MOVIE.toUpperCase(), season_number: 0, extra: 1 })).toEqual({ media_id: MOVIE, season_number: 0, force: false });
  });
});

describe("idempotency", () => {
  it("re-acks a repeated id with the same result and doesn't run it again", () => {
    const { host, calls } = fakeHost("home");
    const p = new CommandProcessor(host);
    const first = p.handle(cmd("media.open", { media_id: MOVIE }, "same"));
    const again = p.handle(cmd("media.open", { media_id: SERIES }, "same"));
    expect(again).toBe(first);
    expect(calls.open).toHaveLength(1);
  });

  it("remembers failures too, and forgets the oldest ids beyond the limit", () => {
    const { host, calls } = fakeHost("home");
    const p = new CommandProcessor(host, 3);
    expect(p.handle(cmd("media.open", {}, "bad"))?.error).toBe("bad_payload");
    expect(p.handle(cmd("media.open", { media_id: MOVIE }, "bad"))?.error).toBe("bad_payload");
    for (const id of ["a", "b", "c"]) p.handle(cmd("device.show_message", { text: "hi" }, id));
    expect(calls.messages).toHaveLength(3);
    // "bad" fell out of the cache: a new command with that id runs.
    expect(p.handle(cmd("media.open", { media_id: MOVIE }, "bad"))?.ok).toBe(true);
    p.handle(cmd("device.show_message", { text: "hi" }, "c"));
    expect(calls.messages).toHaveLength(3);
  });

  it("commands without an id still run (nothing to cache)", () => {
    const { host, calls } = fakeHost("home");
    const p = new CommandProcessor(host);
    p.handle({ type: "device.show_message", payload: { text: "x" } });
    p.handle({ type: "device.show_message", payload: { text: "x" } });
    expect(calls.messages).toHaveLength(2);
  });
});

describe("other commands", () => {
  it("shows messages with the sender and validates the text", () => {
    const { host, calls } = fakeHost("pairing");
    const p = new CommandProcessor(host);
    expect(p.handle(cmd("device.show_message", { text: "  Dinner!  " }))).toEqual({ ok: true });
    expect(calls.messages).toEqual(["Dinner!"]);
    expect(calls.senders).toEqual(["Alex"]);
    expect(p.handle(cmd("device.show_message", { text: "" }))?.error).toBe("bad_payload");
    expect(p.handle(cmd("device.show_message", { text: "x".repeat(201) }))?.error).toBe("bad_payload");
    expect(p.handle(cmd("device.show_message", {}))?.error).toBe("bad_payload");
  });

  it("returns the state for device.request_state", () => {
    const { host } = fakeHost("browse");
    expect(new CommandProcessor(host).handle(cmd("device.request_state"))).toEqual({
      ok: true,
      result: { screen: "browse", profile_id: null, media_id: null, playback: null },
    });
  });

  it("answers unsupported for unknown types", () => {
    const { host } = fakeHost("home");
    const p = new CommandProcessor(host);
    for (const type of ["device.reboot", "x"]) {
      expect(p.handle(cmd(type, { media_id: MOVIE }))).toEqual({ ok: false, error: "unsupported" });
    }
  });

  it("ignores events", () => {
    const { host } = fakeHost("home");
    const p = new CommandProcessor(host);
    for (const type of ["hello", "pong", "ack", "error", "device.presence"]) expect(p.handle({ id: "1", type })).toBeNull();
  });

  it("turns a host error into failed", () => {
    const { host } = fakeHost("home");
    host.open = () => {
      throw new Error("boom");
    };
    expect(new CommandProcessor(host).handle(cmd("media.open", { media_id: MOVIE }))).toEqual({ ok: false, error: "failed" });
  });

  it("names the sender by display name, then username", () => {
    expect(senderName(FROM)).toBe("Alex");
    expect(senderName({ ...FROM, display_name: "" })).toBe("alex");
    expect(senderName(undefined)).toBeNull();
  });
});

describe("device state", () => {
  const profile = { id: "p1", name: "Kids" };

  it("describes non-catalog screens without a profile", () => {
    expect(buildDeviceState({ screen: "profiles", route: { name: "home" }, profile })).toEqual({
      screen: "profiles",
      profile_id: null,
      profile_name: null,
      media_id: null,
      kind: null,
      title: null,
      poster_path: null,
      season_number: null,
      playback: null,
    });
  });

  it("reports the player screen's failure for phones following a media.play", () => {
    const player = { media_id: SERIES, kind: "series" as const, title: "Show", poster_path: null, season_number: 1 };
    expect(buildDeviceState({ screen: "catalog", route: { name: "home" }, profile, player, playerError: "no_releases" })).toMatchObject({
      screen: "player",
      media_id: SERIES,
      player_error: "no_releases",
    });
    expect(buildDeviceState({ screen: "catalog", route: { name: "home" }, profile, player })).not.toHaveProperty("player_error");
  });

  it("describes catalog screens", () => {
    expect(buildDeviceState({ screen: "catalog", route: { name: "search" }, profile })).toMatchObject({
      screen: "search",
      profile_id: "p1",
      profile_name: "Kids",
      media_id: null,
    });
    expect(buildDeviceState({ screen: "catalog", route: { name: "browse", kind: "series" }, profile })).toMatchObject({
      screen: "browse",
      kind: "series",
    });
  });

  it("uses Details info, else the card preview, else the requested season", () => {
    const route = { name: "details" as const, id: SERIES, season: 2 };
    expect(buildDeviceState({ screen: "catalog", route, profile })).toMatchObject({
      screen: "details",
      media_id: SERIES,
      title: null,
      season_number: 2,
    });
    const info = { title: "Show", poster_path: "/p.jpg", kind: "series" as const, season_number: 3 };
    expect(buildDeviceState({ screen: "catalog", route, profile, details: info })).toMatchObject({
      title: "Show",
      poster_path: "/p.jpg",
      kind: "series",
      season_number: 3,
    });
    const preview = { id: MOVIE, kind: "movie", title: "Film", poster_path: "/f.jpg" } as never;
    expect(buildDeviceState({ screen: "catalog", route: { name: "details", id: MOVIE, preview }, profile })).toMatchObject({
      kind: "movie",
      title: "Film",
      poster_path: "/f.jpg",
      season_number: null,
    });
  });

  it("includes playback", () => {
    expect(buildDeviceState({ screen: "catalog", route: { name: "home" }, profile, playback: PLAYING }).playback).toBe(PLAYING);
  });
});

describe("opening Details from outside", () => {
  it("pushes on top so Back returns to the previous screen", () => {
    const s0 = initialStack();
    const s1 = openDetails(s0, { id: MOVIE });
    expect(s1.map((e) => e.route.name)).toEqual(["home", "details"]);
    expect(pop(s1)).toEqual(s0);
  });

  it("replaces Details for the same title instead of stacking it", () => {
    const s1 = openDetails(initialStack(), { id: SERIES, season: 1 });
    const s2 = openDetails(s1, { id: SERIES, season: 2, episode: 4 });
    expect(s2).toHaveLength(2);
    expect(s2[1]!.route).toEqual({ name: "details", id: SERIES, season: 2, episode: 4 });
    expect(s2[1]!.key).not.toBe(s1[1]!.key);
    expect(openDetails(s2, { id: MOVIE })).toHaveLength(3);
  });

  it("keeps the stack bounded", () => {
    let s = [entry({ name: "home" })];
    for (let i = 0; i < 40; i++) s = openDetails(s, { id: `${i}` });
    expect(s.length).toBeLessThanOrEqual(20);
    expect(s[0]!.route.name).toBe("home");
    expect(s[s.length - 1]!.route).toEqual({ name: "details", id: "39" });
  });

  it("picks the requested season if the series has it", () => {
    const seasons = [{ season_number: 0 }, { season_number: 1 }, { season_number: 2 }];
    expect(pickSeason(seasons, 2)).toBe(2);
    expect(pickSeason(seasons, 0)).toBe(0);
    expect(pickSeason(seasons, 7)).toBe(1);
    expect(pickSeason(seasons, null)).toBe(1);
    expect(pickSeason(undefined, 3)).toBe(3);
    expect(pickSeason([], 3)).toBeNull();
    expect(episodeIndex([{ episode_number: 1 }, { episode_number: 2 }], 2)).toBe(1);
    expect(episodeIndex([{ episode_number: 1 }], 9)).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import type { DeviceState, Envelope, PlaybackState } from "@martytv/contracts";
import { CommandProcessor, parseLive, type CommandHost, type LiveRequest } from "../remote/commands";
import { buildDeviceState, type TvScreen } from "../remote/state";

const CH = "11111111-2222-4333-8444-555555555555";
const PLAYING: PlaybackState = { media_id: CH, title: "Movie", position_seconds: 10, duration_seconds: 100, paused: false, buffering: false };

function host(screen: TvScreen, playback: PlaybackState | null = null, live = true) {
  const calls: LiveRequest[] = [];
  const state = (s: Partial<DeviceState> = {}): DeviceState => ({ screen, profile_id: null, media_id: null, playback, ...s });
  const h: CommandHost = {
    screen: () => screen,
    playback: () => playback,
    state: () => state(),
    open: () => state(),
    queue: () => undefined,
    showMessage: () => undefined,
    play: () => state(),
    queuePlay: () => undefined,
    control: () => state(),
    ...(live ? { playLive: (req: LiveRequest) => (calls.push(req), state({ screen: "player" })) } : {}),
  };
  return { h, calls };
}
const cmd = (payload: unknown): Envelope => ({ id: `c-${Math.random()}`, type: "iptv.play", payload });

describe("iptv.play", () => {
  it("validates the payload", () => {
    expect(parseLive({ channel_id: CH.toUpperCase() })).toEqual({ channel_id: CH, force: false });
    expect(parseLive({ channel_id: "nope" })).toBeNull();
    expect(parseLive({ channel_id: CH, profile_id: 5 })).toBeNull();
  });

  it("switches to the channel; busy_playing over a film unless forced", () => {
    const idle = host("home");
    expect(new CommandProcessor(idle.h).handle(cmd({ channel_id: CH, profile_id: CH }))?.ok).toBe(true);
    expect(idle.calls).toEqual([{ channel_id: CH, profile_id: CH }]);

    const busy = host("player", PLAYING);
    const p = new CommandProcessor(busy.h);
    expect(p.handle(cmd({ channel_id: CH }))).toEqual({ ok: false, error: "busy_playing" });
    expect(p.handle(cmd({ channel_id: CH, force: true }))?.ok).toBe(true);
    expect(busy.calls).toEqual([{ channel_id: CH }]);
  });

  it("fails on the profile picker, unsupported without live TV, bad_payload on garbage", () => {
    expect(new CommandProcessor(host("profiles").h).handle(cmd({ channel_id: CH }))).toEqual({ ok: false, error: "failed" });
    expect(new CommandProcessor(host("home", null, false).h).handle(cmd({ channel_id: CH }))).toEqual({ ok: false, error: "unsupported" });
    expect(new CommandProcessor(host("home").h).handle(cmd({}))).toEqual({ ok: false, error: "bad_payload" });
  });
});

describe("device state while live", () => {
  it("reports the player screen with the channel, no media/playback", () => {
    const st = buildDeviceState({
      screen: "catalog",
      route: { name: "tv" },
      profile: { id: "p", name: "Марти" },
      playback: null,
      live: { channel_id: CH, name: "Первый", number: 1, programme: "Новости" },
    });
    expect(st).toEqual(expect.objectContaining({ screen: "player", media_id: null, playback: null, profile_id: "p", live: { channel_id: CH, name: "Первый", number: 1, programme: "Новости" } }));
    expect(buildDeviceState({ screen: "catalog", route: { name: "tv" }, profile: { id: "p", name: "M" } }).screen).toBe("home");
  });
});

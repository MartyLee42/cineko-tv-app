import { describe, expect, it } from "vitest";
import type { DeviceState, Envelope } from "@martytv/contracts";
import {
  applyVolumeChange,
  clampVolume,
  parseVolume,
  platformApis,
  probeSystemVolume,
  readSaved,
  stepVolume,
  VolumeControl,
  type MediaLike,
  type TvAudioControl,
} from "./volume";
import { CommandProcessor, type CommandHost } from "../remote/commands";
import { buildDeviceState } from "../remote/state";
import { liveControl } from "../iptv/live";

describe("volume math", () => {
  it("clamps to 0..1 in whole percent; junk = full", () => {
    expect(clampVolume(0.555)).toBe(0.56);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(7)).toBe(1);
    expect(clampVolume(NaN)).toBe(1);
    expect(clampVolume("x")).toBe(1);
  });

  it("steps by 10 % on the grid (an off-grid level snaps first)", () => {
    expect(stepVolume(0.5, 0.1)).toBe(0.6);
    expect(stepVolume(0.5, -0.1)).toBe(0.4);
    expect(stepVolume(0.55, 0.1)).toBe(0.6);
    expect(stepVolume(0.55, -0.1)).toBe(0.5);
    expect(stepVolume(0.3, 0.1)).toBe(0.4); // float noise (0.3/0.1 = 2.9999…)
    expect(stepVolume(0.95, 0.1)).toBe(1);
    expect(stepVolume(1, 0.1)).toBe(1);
    expect(stepVolume(0.05, -0.1)).toBe(0);
    expect(stepVolume(0, -0.1)).toBe(0);
  });

  it("applies a change: volume wins over delta, a volume change unmutes", () => {
    const cur = { volume: 0.5, muted: true };
    expect(applyVolumeChange(cur, { volume: 0.8, delta: -0.1 })).toEqual({ volume: 0.8, muted: false });
    expect(applyVolumeChange(cur, { delta: 0.1 })).toEqual({ volume: 0.6, muted: false });
    expect(applyVolumeChange(cur, { muted: false })).toEqual({ volume: 0.5, muted: false });
    expect(applyVolumeChange({ volume: 0.5, muted: false }, { muted: true })).toEqual({ volume: 0.5, muted: true });
    expect(applyVolumeChange(cur, { delta: 0.1, muted: true })).toEqual({ volume: 0.6, muted: true });
  });

  it("validates payloads", () => {
    expect(parseVolume({ volume: 0.4 })).toEqual({ volume: 0.4 });
    expect(parseVolume({ delta: -0.1, extra: 1 })).toEqual({ delta: -0.1 });
    expect(parseVolume({ muted: true })).toEqual({ muted: true });
    expect(parseVolume({})).toBeNull();
    expect(parseVolume(null)).toBeNull();
    expect(parseVolume({ volume: 2 })).toBeNull();
    expect(parseVolume({ delta: -3 })).toBeNull();
    expect(parseVolume({ muted: "yes" })).toBeNull();
  });

  it("reads the saved level defensively", () => {
    expect(readSaved('{"volume":0.3,"muted":true}')).toEqual({ volume: 0.3, muted: true });
    expect(readSaved(null)).toEqual({ volume: 1, muted: false });
    expect(readSaved("{oops")).toEqual({ volume: 1, muted: false });
    expect(readSaved('{"volume":9}')).toEqual({ volume: 1, muted: false });
  });
});

/** A fake `tizen.tvaudiocontrol` (0..100 like the real one). */
function fakeTizen(start = 30) {
  let vol = start;
  let mute = false;
  let listener: ((v: number) => void) | null = null;
  const tac: TvAudioControl = {
    getVolume: () => vol,
    setVolume: (v) => {
      vol = v;
      listener?.(v);
    },
    setVolumeUp: () => void (vol = Math.min(100, vol + 1)),
    setVolumeDown: () => void (vol = Math.max(0, vol - 1)),
    setMute: (m) => void (mute = m),
    isMute: () => mute,
    setVolumeChangeListener: (cb) => void (listener = cb),
    unsetVolumeChangeListener: () => void (listener = null),
  };
  return { tac, fire: (v: number) => ((vol = v), listener?.(v)), get: () => ({ vol, mute }) };
}

const throwing = (name: string) => () => {
  const e = new Error("nope");
  e.name = name;
  throw e;
};

function env(win: unknown, saved: string | null = null) {
  const store = { v: saved };
  return { store, env: { win, load: () => store.v, save: (v: string) => void (store.v = v) } };
}

describe("system volume detection", () => {
  it("absent without tizen.tvaudiocontrol", () => {
    expect(probeSystemVolume({}).status).toBe("absent");
    expect(probeSystemVolume(null).status).toBe("absent");
    expect(probeSystemVolume({ tizen: { application: {} } }).status).toBe("absent");
  });

  it("ok when getVolume works", () => {
    const { tac } = fakeTizen();
    const r = probeSystemVolume({ tizen: { tvaudiocontrol: tac } });
    expect(r.status).toBe("ok");
    expect(r.api).toBe(tac);
  });

  it("denied on a SecurityError (no tv.audio privilege), error:<name> otherwise", () => {
    const { tac } = fakeTizen();
    expect(probeSystemVolume({ tizen: { tvaudiocontrol: { ...tac, getVolume: throwing("SecurityError") } } }).status).toBe("denied");
    expect(probeSystemVolume({ tizen: { tvaudiocontrol: { ...tac, getVolume: throwing("NotSupportedError") } } }).status).toBe("error:NotSupportedError");
    expect(probeSystemVolume({ tizen: { tvaudiocontrol: { ...tac, getVolume: () => undefined } } }).status).toBe("error:NoValue");
    // A getter that throws (some Tizen bindings check privileges on access).
    const evil = {
      get tizen(): unknown {
        return throwing("SecurityError")();
      },
    };
    expect(probeSystemVolume(evil).status).toBe("denied");
  });

  it("names the platform objects", () => {
    expect(platformApis({ tizen: { systeminfo: {} }, webapis: {} })).toEqual({ tizen: true, webapis: true, systeminfo: true });
    expect(platformApis({})).toEqual({ tizen: false, webapis: false, systeminfo: false });
  });
});

describe("VolumeControl", () => {
  it("app mode: changes every bound element, persists, and new elements get the saved level", () => {
    const { store, env: e } = env({}, '{"volume":0.5,"muted":false}');
    const c = new VolumeControl(e);
    expect(c.source()).toBe("app");
    expect(c.status()).toBe("absent");
    const v1: MediaLike = { volume: 1, muted: false };
    c.bind(v1);
    expect(v1.volume).toBe(0.5);
    const heard: boolean[] = [];
    c.subscribe((remote) => heard.push(remote));
    expect(c.change({ delta: -0.1 })).toEqual({ volume: 0.4, muted: false });
    expect(v1.volume).toBe(0.4);
    expect(c.change({ muted: true })).toEqual({ volume: 0.4, muted: true });
    expect(v1.muted).toBe(true);
    expect(JSON.parse(store.v!)).toEqual({ volume: 0.4, muted: true });
    expect(heard).toEqual([true, true]);
    // A new film's element starts at the saved level.
    const v2: MediaLike = { volume: 1, muted: false };
    const unbind = c.bind(v2);
    expect(v2).toEqual({ volume: 0.4, muted: true });
    unbind();
    c.change({ volume: 0.9 });
    expect(v2.volume).toBe(0.4); // unbound: untouched
    expect(v1).toEqual({ volume: 0.9, muted: false });
  });

  it("system mode: drives tizen.tvaudiocontrol, elements stay at full, the listener reports TV-side changes", () => {
    const t = fakeTizen(30);
    const c = new VolumeControl(env({ tizen: { tvaudiocontrol: t.tac } }, '{"volume":0.2,"muted":true}').env);
    expect(c.source()).toBe("system");
    const v: MediaLike = { volume: 0.2, muted: true };
    c.bind(v);
    expect(v).toEqual({ volume: 1, muted: false });
    expect(c.level()).toEqual({ volume: 0.3, muted: false });
    expect(c.change({ delta: 0.1 })).toEqual({ volume: 0.4, muted: false });
    expect(t.get()).toEqual({ vol: 40, mute: false });
    expect(c.change({ muted: true })).toEqual({ volume: 0.4, muted: true });
    expect(t.get().mute).toBe(true);
    expect(c.change({ volume: 0.75 })).toEqual({ volume: 0.75, muted: false });
    expect(t.get()).toEqual({ vol: 75, mute: false });
    const heard: boolean[] = [];
    c.subscribe((remote) => heard.push(remote));
    t.fire(12); // the TV's own volume buttons
    expect(heard).toEqual([false]);
    expect(c.level().volume).toBe(0.12);
  });

  it("falls back to the app volume when the system API starts throwing", () => {
    const t = fakeTizen(50);
    const c = new VolumeControl(env({ tizen: { tvaudiocontrol: t.tac } }).env);
    const v: MediaLike = { volume: 1, muted: false };
    c.bind(v);
    t.tac.setVolume = throwing("SecurityError");
    expect(c.change({ volume: 0.3 })).toEqual({ volume: 0.3, muted: false });
    expect(c.source()).toBe("app");
    expect(c.status()).toBe("denied");
    expect(v.volume).toBe(0.3);
  });

  it("denied at startup: the app path", () => {
    const { tac } = fakeTizen();
    const c = new VolumeControl(env({ tizen: { tvaudiocontrol: { ...tac, getVolume: throwing("SecurityError") } } }).env);
    expect(c.status()).toBe("denied");
    expect(c.source()).toBe("app");
    expect(c.change({ delta: -0.1 })).toEqual({ volume: 0.9, muted: false });
  });
});

describe("playback.set_volume command", () => {
  const FROM = { user_id: "u1", username: "alex", display_name: "Alex" };
  const cmd = (payload: unknown): Envelope => ({ id: `c-${Math.random()}`, type: "playback.set_volume", payload, from: FROM });

  function host(screen: DeviceState["screen"]) {
    const c = new VolumeControl(env({}).env);
    const state = (): DeviceState =>
      buildDeviceState({ screen: screen === "profiles" ? "profiles" : "catalog", route: { name: "home" } as never, audio: { ...c.level(), source: c.source(), system: c.status() } });
    const h: CommandHost = {
      screen: () => screen,
      playback: () => null,
      state,
      open: state,
      queue: () => undefined,
      showMessage: () => undefined,
      play: state,
      queuePlay: () => undefined,
      control: () => "failed",
      volume: (change) => {
        c.change(change);
        return state();
      },
    };
    return h;
  }

  it("acks with the new state (volume, muted) even with nothing playing, on any screen", () => {
    const p = new CommandProcessor(host("home"));
    expect(p.handle(cmd({ delta: -0.1 }))).toEqual({ ok: true, result: expect.objectContaining({ volume: 0.9, muted: false, volume_source: "app", system_volume: "absent" }) });
    expect(p.handle(cmd({ muted: true }))).toEqual({ ok: true, result: expect.objectContaining({ volume: 0.9, muted: true }) });
    expect(new CommandProcessor(host("profiles")).handle(cmd({ volume: 0.2 }))?.ok).toBe(true);
  });

  it("bad payloads and TVs without the handler", () => {
    const p = new CommandProcessor(host("home"));
    expect(p.handle(cmd({}))).toEqual({ ok: false, error: "bad_payload" });
    expect(p.handle(cmd({ volume: 3 }))).toEqual({ ok: false, error: "bad_payload" });
    const h = host("home");
    delete h.volume;
    expect(new CommandProcessor(h).handle(cmd({ volume: 0.5 }))).toEqual({ ok: false, error: "unsupported" });
  });
});

describe("live TV remote controls", () => {
  it("pause / resume through the player, stop closes, seeking doesn't apply", () => {
    let paused = false;
    let closed = false;
    const c = { pause: () => ((paused = true), true), resume: () => ((paused = false), true), paused: () => paused };
    expect(liveControl("pause", c, () => (closed = true))).toBe(true);
    expect(paused).toBe(true);
    expect(liveControl("resume", c, () => (closed = true))).toBe(true);
    expect(paused).toBe(false);
    expect(liveControl("seek", c, () => (closed = true))).toBe("unsupported");
    expect(liveControl("pause", null, () => (closed = true))).toBe("failed");
    expect(liveControl("stop", null, () => (closed = true))).toBe(true);
    expect(closed).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { ApiError, CommandError, type DeviceState, type VideoPlaybackState } from "@martytv/contracts";
import { translate, type MessageKey } from "@martytv/ui";
import {
  jumpCommand,
  clampLevel,
  optimisticVolume,
  stepLevel,
  volumeSetCommand,
  volumeStepCommand,
  volumeView,
  remoteControls,
  toggleCommand,
  videoNextCommand,
  videoQualityCommand,
  videoQualityOptions,
  videoStatus,
  ackOutcome,
  chooseDevice,
  createFlowController,
  errorOutcome,
  flowReducer,
  focusDevice,
  formatClock,
  IDLE,
  orderDevices,
  outcomeMessage,
  screenKey,
  seekTarget,
  stateFromResult,
  type Flow,
} from "./logic";

const t = (k: MessageKey, v?: Record<string, string | number>) => translate("en", k, v);
const tv = (id: string, online: boolean, name = id) => ({ id, name, online });
const target = { media_id: "m1" };

describe("device choice", () => {
  it("explains when there is nothing to send to", () => {
    expect(chooseDevice([], null)).toEqual({ kind: "none" });
    expect(chooseDevice([tv("a", false), tv("b", false)], "a")).toEqual({ kind: "offline" });
  });

  it("sends right away when exactly one TV is online", () => {
    expect(chooseDevice([tv("a", false), tv("b", true)], "a")).toEqual({ kind: "auto", deviceId: "b" });
  });

  it("asks when several are online, preselecting the last used one if online", () => {
    expect(chooseDevice([tv("a", true), tv("b", true)], "b")).toEqual({ kind: "pick", preferred: "b" });
    expect(chooseDevice([tv("a", true), tv("b", true), tv("c", false)], "c")).toEqual({ kind: "pick", preferred: null });
  });

  it("orders the picker: last used, online, offline, then by name", () => {
    const list = [tv("x", false, "Attic"), tv("y", true, "Kitchen"), tv("z", true, "Bedroom"), tv("w", true, "Living")];
    expect(orderDevices(list, "w").map((d) => d.name)).toEqual(["Living", "Bedroom", "Kitchen", "Attic"]);
  });

  it("focuses the last used online TV, else the only online one", () => {
    expect(focusDevice([tv("a", true), tv("b", true)], "b")?.id).toBe("b");
    expect(focusDevice([tv("a", true), tv("b", true)], null)).toBeNull();
    expect(focusDevice([tv("a", true), tv("b", false)], "b")?.id).toBe("a");
  });
});

describe("ack → message", () => {
  it("maps acks to outcomes", () => {
    expect(ackOutcome({ ok: true, result: { screen: "details", media_id: "m1" } })).toEqual({ kind: "sent" });
    expect(ackOutcome({ ok: true, result: { queued: true } })).toEqual({ kind: "queued" });
    expect(ackOutcome({ ok: false, error: "busy_playing" })).toEqual({ kind: "busy" });
    expect(ackOutcome({ ok: false, error: "unsupported" })).toEqual({ kind: "error", code: "unsupported" });
  });

  it("maps thrown errors to outcomes", () => {
    expect(errorOutcome(new CommandError("busy_playing"))).toEqual({ kind: "busy" });
    expect(errorOutcome(new CommandError("timeout"))).toEqual({ kind: "error", code: "timeout" });
    expect(errorOutcome(new ApiError(0, undefined))).toEqual({ kind: "error", code: "network" });
    expect(errorOutcome(new ApiError(404, { error: { code: "not_found", message: "x" } }))).toEqual({ kind: "error", code: "forbidden" });
    expect(errorOutcome(new Error("boom"))).toEqual({ kind: "error", code: "failed" });
  });

  it("renders a message for every outcome", () => {
    expect(outcomeMessage({ kind: "sent" }, "Den", t)).toBe("Opened on Den.");
    expect(outcomeMessage({ kind: "queued" }, "Den", t)).toBe("Den will show it after a profile is chosen.");
    expect(outcomeMessage({ kind: "error", code: "device_offline" }, "Den", t)).toBe("The TV is offline.");
    expect(outcomeMessage({ kind: "error", code: "not_found" }, "Den", t)).toBe("That title wasn't found.");
    expect(outcomeMessage({ kind: "error", code: "bad_payload" }, "Den", t)).toBe("The TV couldn't do that (bad_payload).");
  });

  it("extracts a DeviceState from an ack result", () => {
    expect(stateFromResult({ queued: true })).toBeNull();
    expect(stateFromResult({ screen: "details", media_id: "m", profile_id: null, playback: null })?.screen).toBe("details");
  });
});

describe("send flow", () => {
  const run = (...actions: Parameters<typeof flowReducer>[1][]) => actions.reduce<Flow>(flowReducer, IDLE);

  it("auto-sends to the only online TV and ignores taps while pending", () => {
    const sending = run({ type: "request", target, choice: { kind: "auto", deviceId: "a" } });
    expect(sending).toEqual({ step: "sending", target, deviceId: "a", force: false });
    expect(flowReducer(sending, { type: "request", target: { media_id: "m2" }, choice: { kind: "auto", deviceId: "b" } })).toBe(sending);
  });

  it("picks a TV, then shows the result", () => {
    const s = run(
      { type: "request", target, choice: { kind: "pick", preferred: "b" } },
      { type: "pick", deviceId: "b" },
      { type: "outcome", outcome: { kind: "sent" } },
    );
    expect(s).toEqual({ step: "done", target, deviceId: "b", outcome: { kind: "sent" } });
    expect(flowReducer(s, { type: "dismiss" })).toEqual(IDLE);
  });

  it("asks before interrupting playback and resends with force", () => {
    const confirm = run(
      { type: "request", target, choice: { kind: "auto", deviceId: "a" } },
      { type: "outcome", outcome: { kind: "busy" } },
    );
    expect(confirm).toEqual({ step: "confirm", target, deviceId: "a" });
    expect(flowReducer(confirm, { type: "cancel" })).toEqual(IDLE);
    const forced = flowReducer(confirm, { type: "confirm" });
    expect(forced).toEqual({ step: "sending", target, deviceId: "a", force: true });
    // Still busy after forcing: report it instead of asking again.
    expect(flowReducer(forced, { type: "outcome", outcome: { kind: "busy" } })).toMatchObject({
      step: "done",
      outcome: { kind: "error", code: "busy_playing" },
    });
  });

  it("opens the picker for the no-TV / offline explanations", () => {
    expect(run({ type: "request", target, choice: { kind: "none" } })).toEqual({ step: "picking", target, preferred: null });
    expect(run({ type: "request", target, choice: { kind: "offline" } }).step).toBe("picking");
  });
});

describe("display helpers", () => {
  it("labels screens", () => {
    expect(screenKey("details")).toBe("remote.screen.details");
    expect(screenKey("boot")).toBe("remote.screen.other");
    expect(screenKey(null)).toBe("remote.screen.other");
  });

  it("formats clocks and clamps seeks", () => {
    expect(formatClock(42)).toBe("0:42");
    expect(formatClock(3729)).toBe("1:02:09");
    expect(formatClock(null)).toBe("--:--");
    expect(seekTarget(5, -10, 100)).toBe(0);
    expect(seekTarget(90, 30, 100)).toBe(100);
    expect(seekTarget(90, 30, null)).toBe(120);
  });
});

describe("flow controller", () => {
  it("sends once on a double tap and feeds the outcome back", async () => {
    const seen: Flow[] = [];
    let sends = 0;
    const dispatch = createFlowController(
      (f) => seen.push(f),
      async () => {
        sends++;
        return { kind: "busy" };
      },
    );
    const req = { type: "request", target, choice: { kind: "auto", deviceId: "a" } } as const;
    dispatch(req);
    dispatch(req);
    await Promise.resolve();
    await Promise.resolve();
    expect(sends).toBe(1);
    expect(seen.at(-1)).toEqual({ step: "confirm", target, deviceId: "a" });
    dispatch({ type: "confirm" });
    expect(sends).toBe(2);
  });
});

// ---------------------------------------------------------------- «Видео» on the remote

const VIDEO: VideoPlaybackState = {
  video_id: "dQw4w9WgXcQ",
  title: "Рецепт борща",
  channel_id: "UCabcdefghijklmnopqrstuv",
  channel_name: "Марти Влог",
  thumbnail: "/api/v1/video/thumbs/vi/dQw4w9WgXcQ/mqdefault.jpg",
  position_seconds: 42.6,
  duration_seconds: 300,
  paused: false,
  buffering: false,
  quality: 720,
  qualities: [1080, 720, 480, 360, 240],
  volume: 0.8,
  error: null,
};
const base: DeviceState = { screen: "player", profile_id: null, media_id: null, playback: null, title: "Рецепт борща" };

describe("remoteControls", () => {
  it("is null with nothing playing", () => {
    expect(remoteControls(null)).toBeNull();
    expect(remoteControls({ ...base, screen: "home" })).toBeNull();
  });
  it("maps a YouTube video", () => {
    expect(remoteControls({ ...base, video: VIDEO })).toEqual({ kind: "video", position: 42.6, duration: 300, paused: false, buffering: false, volume: 0.8 });
  });
  it("no controls for a video the TV couldn't play", () => {
    expect(remoteControls({ ...base, video: { ...VIDEO, error: "unavailable" } })).toBeNull();
  });
  it("prefers a film's playback", () => {
    const c = remoteControls({
      ...base,
      video: VIDEO,
      playback: { media_id: "m", title: "Film", position_seconds: 10, duration_seconds: null, paused: true, buffering: true },
    });
    expect(c).toEqual({ kind: "film", position: 10, duration: null, paused: true, buffering: true, volume: null });
  });
});

describe("video remote commands", () => {
  const c = remoteControls({ ...base, video: VIDEO })!;
  it("play/pause follows the TV's state", () => {
    expect(toggleCommand(c)).toEqual({ type: "media.pause", payload: undefined });
    expect(toggleCommand({ ...c, paused: true })).toEqual({ type: "media.resume", payload: undefined });
  });
  it("−10 / +30 seek, clamped", () => {
    expect(jumpCommand(c, -10)).toEqual({ type: "media.seek", payload: { position_seconds: 33 } });
    expect(jumpCommand(c, 30)).toEqual({ type: "media.seek", payload: { position_seconds: 73 } });
    expect(jumpCommand({ ...c, position: 290 }, 30)).toEqual({ type: "media.seek", payload: { position_seconds: 300 } });
    expect(jumpCommand({ ...c, position: 4 }, -10)).toEqual({ type: "media.seek", payload: { position_seconds: 0 } });
  });
  it("quality: what the video offers ∩ the video.play caps; switches in place with force", () => {
    expect(videoQualityOptions(VIDEO)).toEqual([1080, 720, 480]);
    expect(videoQualityOptions({ qualities: [720, 360], quality: 720 })).toEqual([]);
    expect(videoQualityOptions({ qualities: [480, 360], quality: 720 })).toEqual([720, 480]);
    expect(videoQualityCommand(VIDEO, 1080)).toEqual({
      type: "video.play",
      payload: { video_id: "dQw4w9WgXcQ", quality: 1080, position_seconds: 42, force: true },
    });
  });
  it("next video replaces the current one", () => {
    expect(videoNextCommand("abcdefghijk")).toEqual({ type: "video.play", payload: { video_id: "abcdefghijk", force: true } });
  });
  it("status", () => {
    expect(videoStatus(VIDEO)).toBe("playing");
    expect(videoStatus({ ...VIDEO, paused: true })).toBe("paused");
    expect(videoStatus({ ...VIDEO, buffering: true })).toBe("loading");
    expect(videoStatus({ ...VIDEO, error: "failed" })).toBe("error");
  });
});

describe("remote volume (playback.set_volume)", () => {
  const base: DeviceState = { screen: "home", profile_id: null, media_id: null, playback: null };

  it("reads the TV's reported level (top-level volume/muted/source); none from old TVs", () => {
    expect(volumeView({ ...base, volume: 0.6, muted: true, volume_source: "system" })).toEqual({ volume: 0.6, muted: true, source: "system" });
    expect(volumeView({ ...base, volume: 0.4 })).toEqual({ volume: 0.4, muted: false, source: "app" });
    expect(volumeView(base)).toBeNull();
    expect(volumeView(null)).toBeNull();
  });

  it("steps on the 10 % grid and clamps", () => {
    expect(stepLevel(0.5, 1)).toBe(0.6);
    expect(stepLevel(0.55, 1)).toBe(0.6);
    expect(stepLevel(0.55, -1)).toBe(0.5);
    expect(stepLevel(0.3, 1)).toBe(0.4);
    expect(stepLevel(1, 1)).toBe(1);
    expect(stepLevel(0, -1)).toBe(0);
    expect(clampLevel(1.4)).toBe(1);
    expect(clampLevel(-2)).toBe(0);
  });

  it("builds commands (deltas of 10 %, absolute snapped) and the optimistic level", () => {
    expect(volumeStepCommand(-1)).toEqual({ delta: -0.1 });
    expect(volumeStepCommand(1)).toEqual({ delta: 0.1 });
    expect(volumeSetCommand(0.73)).toEqual({ volume: 0.7 });
    const cur = { volume: 0.5, muted: true, source: "app" as const };
    expect(optimisticVolume(cur, { delta: 0.1 })).toEqual({ volume: 0.6, muted: false, source: "app" });
    expect(optimisticVolume(cur, { muted: false })).toEqual({ ...cur, muted: false });
    expect(optimisticVolume({ ...cur, muted: false }, { muted: true })).toEqual({ ...cur, muted: true });
    expect(optimisticVolume(cur, { volume: 0.2 })).toEqual({ volume: 0.2, muted: false, source: "app" });
  });

  it("live TV gets play/pause controls (no seeking)", () => {
    const live = { channel_id: "c", name: "Первый", number: 1, programme: null, paused: true };
    expect(remoteControls({ ...base, screen: "player", live })).toEqual({ kind: "live", position: 0, duration: null, paused: true, buffering: false, volume: null });
    expect(toggleCommand(remoteControls({ ...base, screen: "player", live })!)).toEqual({ type: "media.resume", payload: undefined });
    expect(toggleCommand(remoteControls({ ...base, screen: "player", live: { ...live, paused: false } })!)).toEqual({ type: "media.pause", payload: undefined });
  });
});

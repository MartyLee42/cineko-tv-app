// Pure Send-to-TV / remote logic (no React, no I/O) so it can be unit tested.
import { ApiError, CommandError, type AckPayload, type CommandPayloads, type DeviceState, type VideoPlaybackState } from "@martytv/contracts";
import type { MessageKey } from "@martytv/ui";

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

export interface DeviceLite {
  id: string;
  name: string;
  online: boolean;
}

// ---------------------------------------------------------------- device choice

export type Choice =
  | { kind: "none" } // no TVs paired / shared
  | { kind: "offline" } // TVs exist but none is online
  | { kind: "auto"; deviceId: string } // exactly one online: send right away
  | { kind: "pick"; preferred: string | null }; // several online: ask

/** Decides whether to send straight away or ask which TV to use. */
export function chooseDevice(devices: DeviceLite[], lastUsed: string | null): Choice {
  if (!devices.length) return { kind: "none" };
  const online = devices.filter((d) => d.online);
  if (!online.length) return { kind: "offline" };
  if (online.length === 1) return { kind: "auto", deviceId: online[0]!.id };
  return { kind: "pick", preferred: online.some((d) => d.id === lastUsed) ? lastUsed : null };
}

/** Picker order: last used (if online) first, then online TVs, then by name. */
export function orderDevices<D extends DeviceLite>(devices: D[], lastUsed: string | null): D[] {
  const rank = (d: D) => (d.online ? (d.id === lastUsed ? 0 : 1) : 2);
  return [...devices].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * The TV a "now on TV" shortcut should point at: the last used TV when it is
 * online, else the only online TV. Null when that is ambiguous or nothing is on.
 */
export function focusDevice<D extends DeviceLite>(devices: D[], lastUsed: string | null): D | null {
  const online = devices.filter((d) => d.online);
  return online.find((d) => d.id === lastUsed) ?? (online.length === 1 ? online[0]! : null);
}

// ---------------------------------------------------------------- outcomes

export type Outcome =
  | { kind: "sent" }
  | { kind: "queued" }
  | { kind: "busy" }
  | { kind: "error"; code: string };

/** Maps a successful (or failed) ack payload to an outcome. */
export function ackOutcome(ack: AckPayload): Outcome {
  if (!ack.ok) return errorOutcome(new CommandError(ack.error ?? "failed"));
  const r = ack.result as { queued?: unknown } | null | undefined;
  return r && typeof r === "object" && r.queued === true ? { kind: "queued" } : { kind: "sent" };
}

/** Maps anything thrown while sending (CommandError, ApiError, …) to an outcome. */
export function errorOutcome(err: unknown): Outcome {
  if (err instanceof CommandError) {
    return err.code === "busy_playing" ? { kind: "busy" } : { kind: "error", code: err.code };
  }
  if (err instanceof ApiError) {
    if (err.status === 0) return { kind: "error", code: "network" };
    if (err.status === 404) return { kind: "error", code: "forbidden" };
    if (err.status === 422) return { kind: "error", code: "bad_payload" };
    return { kind: "error", code: err.code };
  }
  return { kind: "error", code: "failed" };
}

const ERROR_KEYS: Record<string, MessageKey> = {
  device_offline: "remote.error.device_offline",
  timeout: "remote.error.timeout",
  forbidden: "remote.error.forbidden",
  unsupported: "remote.error.unsupported",
  not_found: "remote.error.not_found",
  network: "common.network_error",
};

export function errorMessage(code: string, t: T): string {
  const key = ERROR_KEYS[code];
  return key ? t(key) : t("remote.error.generic", { code });
}

export function outcomeMessage(o: Outcome, tv: string, t: T): string {
  switch (o.kind) {
    case "sent":
      return t("remote.sent", { tv });
    case "queued":
      return t("remote.queued", { tv });
    case "busy":
      return errorMessage("busy_playing", t);
    case "error":
      return errorMessage(o.code, t);
  }
}

/** A DeviceState carried in an ack's `result` (media.open replies with one). */
export function stateFromResult(result: unknown): DeviceState | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Partial<DeviceState>;
  return typeof r.screen === "string" && "media_id" in r ? (r as DeviceState) : null;
}

// ---------------------------------------------------------------- send flow

export interface SendTarget {
  media_id: string;
  season_number?: number;
  episode_number?: number;
}

export type Flow =
  | { step: "idle" }
  | { step: "picking"; target: SendTarget; preferred: string | null }
  | { step: "sending"; target: SendTarget; deviceId: string; force: boolean }
  | { step: "confirm"; target: SendTarget; deviceId: string }
  | { step: "done"; target: SendTarget; deviceId: string | null; outcome: Outcome };

export type FlowAction =
  | { type: "request"; target: SendTarget; choice: Choice }
  | { type: "pick"; deviceId: string }
  | { type: "outcome"; outcome: Outcome }
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "dismiss" };

export const IDLE: Flow = { step: "idle" };

/**
 * Send-to-TV state machine. A command is sent whenever the flow *enters*
 * "sending"; while sending, new requests are ignored (no double sends). A
 * busy_playing answer to a normal send asks for confirmation; confirming sends
 * again with force (the caller uses a new command id for it).
 */
export function flowReducer(s: Flow, a: FlowAction): Flow {
  switch (a.type) {
    case "request":
      if (s.step === "sending") return s;
      if (a.choice.kind === "auto") return { step: "sending", target: a.target, deviceId: a.choice.deviceId, force: false };
      return { step: "picking", target: a.target, preferred: a.choice.kind === "pick" ? a.choice.preferred : null };
    case "pick":
      return s.step === "picking" ? { step: "sending", target: s.target, deviceId: a.deviceId, force: false } : s;
    case "outcome":
      if (s.step !== "sending") return s;
      if (a.outcome.kind === "busy" && !s.force) return { step: "confirm", target: s.target, deviceId: s.deviceId };
      return {
        step: "done",
        target: s.target,
        deviceId: s.deviceId,
        outcome: a.outcome.kind === "busy" ? { kind: "error", code: "busy_playing" } : a.outcome,
      };
    case "confirm":
      return s.step === "confirm" ? { step: "sending", target: s.target, deviceId: s.deviceId, force: true } : s;
    case "cancel":
      return s.step === "picking" || s.step === "confirm" ? IDLE : s;
    case "dismiss":
      return s.step === "done" ? IDLE : s;
  }
}

/** Same target on both sides (ignores undefined fields). */
export function sameTarget(a: SendTarget, b: SendTarget): boolean {
  return a.media_id === b.media_id && a.season_number === b.season_number && a.episode_number === b.episode_number;
}

// ---------------------------------------------------------------- display helpers

const SCREEN_KEYS: Record<string, MessageKey> = {
  home: "remote.screen.home",
  search: "remote.screen.search",
  browse: "remote.screen.browse",
  details: "remote.screen.details",
  profiles: "remote.screen.profiles",
  pairing: "remote.screen.pairing",
  player: "remote.screen.player",
};

export function screenKey(screen: string | null | undefined): MessageKey {
  return (screen && SCREEN_KEYS[screen]) || "remote.screen.other";
}

/** 0:42, 12:05, 1:02:09 */
export function formatClock(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "--:--";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Clamped seek target for a relative jump. */
export function seekTarget(position: number, delta: number, duration: number | null | undefined): number {
  const max = duration && duration > 0 ? duration : Infinity;
  return Math.max(0, Math.min(max, Math.round(position + delta)));
}

export type Sending = Extract<Flow, { step: "sending" }>;

/**
 * Runs the flow outside React state so a second tap in the same frame sees
 * the "sending" step synchronously: `send` is called exactly once per entry
 * into "sending", and its outcome is fed back in.
 */
export function createFlowController(onChange: (f: Flow) => void, send: (s: Sending) => Promise<Outcome>) {
  let current: Flow = IDLE;
  const dispatch = (a: FlowAction) => {
    const next = flowReducer(current, a);
    if (next === current) return;
    current = next;
    onChange(next);
    if (next.step === "sending") void send(next).then((outcome) => dispatch({ type: "outcome", outcome }));
  };
  return dispatch;
}

// ---------------------------------------------------------------- remote controls (films and «Видео»)

/** What the playback controls work on: a film/episode (playback), a YouTube video or a live channel (play/pause only). */
export interface RemoteControls {
  kind: "film" | "video" | "live";
  position: number;
  duration: number | null;
  paused: boolean;
  buffering: boolean;
  volume: number | null;
}

/** The controls for a device state; null when nothing controllable plays (or the video failed). */
export function remoteControls(s: DeviceState | null | undefined): RemoteControls | null {
  if (!s) return null;
  const p = s.playback;
  if (p) return { kind: "film", position: p.position_seconds, duration: p.duration_seconds ?? null, paused: p.paused, buffering: p.buffering, volume: p.volume ?? null };
  const v = s.video;
  if (v && !v.error) {
    return { kind: "video", position: v.position_seconds, duration: v.duration_seconds ?? null, paused: v.paused, buffering: v.buffering, volume: v.volume ?? null };
  }
  if (s.live) return { kind: "live", position: 0, duration: null, paused: s.live.paused ?? false, buffering: false, volume: null };
  return null;
}

// ---------------------------------------------------------------- volume (playback.set_volume)

/** The remote's volume steps (10 %). */
export const VOLUME_STEP = 0.1;

export interface VolumeView {
  /** 0..1 */
  volume: number;
  muted: boolean;
  /** system = the TV's own volume; app = Cineko's player volume. */
  source: "system" | "app";
}

/** The TV's reported level; older TVs only had playback/video.volume (read-only: no muted). */
export function volumeView(s: DeviceState | null | undefined): VolumeView | null {
  if (!s) return null;
  if (typeof s.volume === "number") return { volume: clampLevel(s.volume), muted: !!s.muted, source: s.volume_source === "system" ? "system" : "app" };
  return null;
}

/** 0..1 in whole percent. */
export function clampLevel(v: number): number {
  return isFinite(v) ? Math.round(Math.min(1, Math.max(0, v)) * 100) / 100 : 1;
}

/** One step from `cur` on the 10 % grid (like the TV: 55 % + step = 60 %). */
export function stepLevel(cur: number, dir: 1 | -1): number {
  const units = clampLevel(cur) / VOLUME_STEP;
  const base = dir > 0 ? Math.floor(units + 1e-6) : Math.ceil(units - 1e-6);
  return clampLevel((base + dir) * VOLUME_STEP);
}

export type VolumePayload = CommandPayloads["playback.set_volume"];

/** «Тише» / «Громче». */
export function volumeStepCommand(dir: 1 | -1): VolumePayload {
  return { delta: dir * VOLUME_STEP };
}

/** The bar / slider: an absolute level (snapped to 10 %). */
export function volumeSetCommand(level: number): VolumePayload {
  return { volume: Math.round(clampLevel(level) * 10) / 10 };
}

/** What the TV will show after a command (optimistic UI; the TV's next state is the truth). */
export function optimisticVolume(cur: VolumeView, p: VolumePayload): VolumeView {
  let volume = cur.volume;
  if (typeof p.volume === "number") volume = clampLevel(p.volume);
  else if (typeof p.delta === "number") volume = stepLevel(cur.volume, p.delta > 0 ? 1 : -1);
  const touched = typeof p.volume === "number" || typeof p.delta === "number";
  const muted = typeof p.muted === "boolean" ? p.muted : touched ? false : cur.muted;
  return { ...cur, volume, muted };
}

/** A command the remote sends (type + its payload). */
export type RemoteCmd = { [K in keyof CommandPayloads]: { type: K; payload: CommandPayloads[K] } }[keyof CommandPayloads];

/** Play/pause toggles on the TV's reported state. */
export function toggleCommand(c: RemoteControls): RemoteCmd {
  return c.paused ? { type: "media.resume", payload: undefined } : { type: "media.pause", payload: undefined };
}

/** A relative jump (−10 s / +30 s), clamped to the video. */
export function jumpCommand(c: RemoteControls, delta: number): RemoteCmd {
  return { type: "media.seek", payload: { position_seconds: seekTarget(c.position, delta, c.duration) } };
}

/** The heights video.play accepts as a quality cap. */
export const VIDEO_QUALITIES = [1080, 720, 480] as const;
export type VideoQuality = (typeof VIDEO_QUALITIES)[number];

/** Quality choices for the TV's video: what it offers ∩ the caps video.play takes (descending). */
export function videoQualityOptions(v: Pick<VideoPlaybackState, "qualities" | "quality">): VideoQuality[] {
  const offered = new Set(v.qualities ?? []);
  const out = VIDEO_QUALITIES.filter((q) => offered.has(q) || q === v.quality);
  return out.length > 1 ? [...out] : [];
}

/** Switches the TV's video to a quality in place (same video, from where it is). */
export function videoQualityCommand(v: Pick<VideoPlaybackState, "video_id" | "position_seconds">, quality: VideoQuality): RemoteCmd {
  return { type: "video.play", payload: { video_id: v.video_id, quality, position_seconds: Math.max(0, Math.floor(v.position_seconds)), force: true } };
}

/** «Следующее видео»: plays another video over the current one. */
export function videoNextCommand(videoId: string): RemoteCmd {
  return { type: "video.play", payload: { video_id: videoId, force: true } };
}

/** The status line of the TV's video. */
export function videoStatus(v: VideoPlaybackState): "error" | "loading" | "paused" | "playing" {
  if (v.error) return "error";
  if (v.buffering) return "loading";
  return v.paused ? "paused" : "playing";
}

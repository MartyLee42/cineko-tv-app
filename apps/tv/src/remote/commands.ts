// Realtime commands from phones: validation, the decision for the current
// screen, and idempotent acks. Pure apart from the injected host, so the
// rules are unit-tested without React or a WebSocket.
import type { AckPayload, CommandErrorCode, DeviceState, Envelope, PlaybackState, PlayerKind } from "@martytv/contracts";
import type { TvScreen } from "./state";
import { parseVideoPlay, type VideoPlayRequest } from "../video/logic";
import { parseVolume, type VolumeChange } from "../player/volume";

export type { VideoPlayRequest, VolumeChange };

/** A validated media.open. */
export interface OpenRequest {
  media_id: string;
  season_number?: number;
  episode_number?: number;
}

/** A validated media.play. */
export interface PlayRequest {
  media_id: string;
  episode_id?: string;
  source_id?: string;
  /** A release chosen on the phone: the TV creates the source itself. */
  release_id?: string;
  /** Online variants: the wanted quality for release_id. */
  quality?: number;
  position_seconds?: number;
  /** Requested player; omitted = the TV's default. */
  player?: PlayerKind;
}

const PLAYERS: readonly string[] = ["builtin", "msx", "external"];

/** A validated iptv.play (live TV channel). */
export interface LiveRequest {
  channel_id: string;
  profile_id?: string;
}

/** Playback control commands, after validation. */
export type PlayerCommand =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "seek"; position_seconds: number }
  | { type: "next_episode" }
  | { type: "select_source"; source_id: string }
  | { type: "set_audio"; track_id: string }
  | { type: "set_subtitles"; track_id: string | null };

/** Who sent a command (display name, else username), if the server said. */
export type Sender = string | null;

/** What the app does for the processor. All calls are synchronous. */
export interface CommandHost {
  /** The screen the TV shows right now. */
  screen(): TvScreen;
  playback(): PlaybackState | null;
  state(): DeviceState;
  /** Opens Details now and returns the new state. */
  open(req: OpenRequest, sender: Sender): DeviceState;
  /** Remembers the open until a profile is chosen (latest wins). */
  queue(req: OpenRequest, sender: Sender): void;
  showMessage(text: string, sender: Sender): void;
  /**
   * Starts playback now (the player shows "preparing") and returns the new
   * state, or `unsupported` when the requested player isn't available.
   */
  play(req: PlayRequest, sender: Sender): DeviceState | CommandErrorCode;
  /** Remembers a media.play until a profile is chosen (latest wins). */
  queuePlay(req: PlayRequest, sender: Sender): void;
  /** Runs a playback control: the new state, or why it can't. */
  control(cmd: PlayerCommand): DeviceState | CommandErrorCode;
  /** iptv.play: switches to the live channel (opens asynchronously); absent = unsupported. */
  playLive?(req: LiveRequest, sender: Sender): DeviceState | CommandErrorCode;
  /** video.play: plays a YouTube video («Видео»); absent = unsupported. */
  playVideo?(req: VideoPlayRequest, sender: Sender): DeviceState | CommandErrorCode;
  /**
   * playback.set_volume: changes the TV's level on any screen (stored for the
   * next playback when nothing plays) and returns the new state; absent = unsupported.
   */
  volume?(change: VolumeChange): DeviceState | CommandErrorCode;
  /** Something plays that isn't in `playback()` (a YouTube video): asks before replacing it. */
  busy?(): boolean;
  /**
   * The playback is still loading (the loading screen, no picture yet):
   * another media.play replaces it without asking — nothing to lose yet, like
   * choosing another release in the TV's own picker.
   */
  loading?(): boolean;
}

/** Playback commands (Phase 4). */
export const PLAYBACK_COMMANDS = [
  "media.play",
  "media.pause",
  "media.resume",
  "media.stop",
  "media.seek",
  "media.next_episode",
  "media.select_source",
  "playback.set_audio",
  "playback.set_subtitles",
  "playback.set_volume",
] as const;

/** Server → TV messages that aren't commands (never acked). */
const EVENTS = new Set(["hello", "pong", "ping", "error", "ack", "device.state", "device.presence", "device.changed", "message", "settings.changed"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Screens where the catalog (a chosen profile) is showing. */
const CATALOG: ReadonlySet<TvScreen> = new Set<TvScreen>(["home", "search", "browse", "details", "player"]);

const fail = (error: CommandErrorCode): AckPayload => ({ ok: false, error });

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInt(v: unknown, min: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= 10_000;
}

/** Validates a media.open payload (the server validates too; be defensive). */
export function parseOpen(p: unknown): (OpenRequest & { force: boolean }) | null {
  if (!isObject(p)) return null;
  const { media_id, season_number, episode_number, force } = p;
  if (typeof media_id !== "string" || !UUID.test(media_id)) return null;
  if (season_number !== undefined && season_number !== null && !isInt(season_number, 0)) return null;
  if (episode_number !== undefined && episode_number !== null && !isInt(episode_number, 1)) return null;
  const hasSeason = typeof season_number === "number";
  const hasEpisode = typeof episode_number === "number";
  if (hasEpisode && !hasSeason) return null;
  if (force !== undefined && force !== null && typeof force !== "boolean") return null;
  const req: OpenRequest & { force: boolean } = { media_id: media_id.toLowerCase(), force: force === true };
  if (hasSeason) req.season_number = season_number;
  if (hasEpisode) req.episode_number = episode_number;
  return req;
}

function optional(v: unknown): boolean {
  return v === undefined || v === null;
}

/** Validates a media.play payload. */
export function parsePlay(p: unknown): (PlayRequest & { force: boolean }) | null {
  if (!isObject(p)) return null;
  const { media_id, episode_id, source_id, release_id, quality, position_seconds, force, player } = p;
  if (typeof media_id !== "string" || !UUID.test(media_id)) return null;
  if (!optional(episode_id) && (typeof episode_id !== "string" || !UUID.test(episode_id))) return null;
  if (!optional(source_id) && (typeof source_id !== "string" || source_id.length === 0 || source_id.length > 128)) return null;
  if (!optional(release_id) && (typeof release_id !== "string" || release_id.length === 0 || release_id.length > 128)) return null;
  if (!optional(quality) && !(typeof quality === "number" && Number.isInteger(quality) && quality >= 1 && quality <= 4320)) return null;
  if (!optional(position_seconds) && !isPosition(position_seconds)) return null;
  if (!optional(force) && typeof force !== "boolean") return null;
  if (!optional(player) && (typeof player !== "string" || !PLAYERS.includes(player))) return null;
  const req: PlayRequest & { force: boolean } = { media_id: media_id.toLowerCase(), force: force === true };
  if (typeof episode_id === "string") req.episode_id = episode_id.toLowerCase();
  if (typeof source_id === "string") req.source_id = source_id;
  if (typeof release_id === "string") req.release_id = release_id;
  if (typeof quality === "number") req.quality = quality;
  if (typeof position_seconds === "number") req.position_seconds = position_seconds;
  if (typeof player === "string") req.player = player as PlayerKind;
  return req;
}

function isPosition(v: unknown): v is number {
  return typeof v === "number" && isFinite(v) && v >= 0 && v < 1e6;
}

/** Validates an iptv.play payload. */
export function parseLive(p: unknown): (LiveRequest & { force: boolean }) | null {
  if (!isObject(p)) return null;
  const { channel_id, profile_id, force } = p;
  if (typeof channel_id !== "string" || !UUID.test(channel_id)) return null;
  if (!optional(profile_id) && (typeof profile_id !== "string" || !UUID.test(profile_id))) return null;
  if (!optional(force) && typeof force !== "boolean") return null;
  const req: LiveRequest & { force: boolean } = { channel_id: channel_id.toLowerCase(), force: force === true };
  if (typeof profile_id === "string") req.profile_id = profile_id.toLowerCase();
  return req;
}

/** Validates a playback control command's payload. */
export function parseControl(type: string, p: unknown): PlayerCommand | null {
  switch (type) {
    case "media.pause":
      return { type: "pause" };
    case "media.resume":
      return { type: "resume" };
    case "media.stop":
      return { type: "stop" };
    case "media.next_episode":
      return { type: "next_episode" };
    case "media.seek":
      return isObject(p) && isPosition(p.position_seconds) ? { type: "seek", position_seconds: p.position_seconds } : null;
    case "media.select_source":
      return isObject(p) && typeof p.source_id === "string" && p.source_id.length > 0 && p.source_id.length <= 128
        ? { type: "select_source", source_id: p.source_id }
        : null;
    case "playback.set_audio":
      return isObject(p) && typeof p.track_id === "string" && p.track_id.length > 0 && p.track_id.length <= 64
        ? { type: "set_audio", track_id: p.track_id }
        : null;
    case "playback.set_subtitles":
      if (!isObject(p) || !("track_id" in p)) return null;
      if (p.track_id === null) return { type: "set_subtitles", track_id: null };
      return typeof p.track_id === "string" && p.track_id.length > 0 && p.track_id.length <= 64 ? { type: "set_subtitles", track_id: p.track_id } : null;
    default:
      return null;
  }
}

/** Validates a device.show_message payload; returns the text to show. */
export function parseMessage(p: unknown): string | null {
  if (!isObject(p) || typeof p.text !== "string") return null;
  const text = p.text.trim();
  return text.length > 0 && p.text.length <= 200 ? text : null;
}

export function senderName(from: Envelope["from"]): Sender {
  if (!from) return null;
  const name = (from.display_name || from.username || "").trim();
  return name ? name.slice(0, 60) : null;
}

/**
 * Executes commands and builds their acks. A command id seen before (a retry)
 * gets the same ack again without running twice.
 */
export class CommandProcessor {
  private done = new Map<string, AckPayload>();

  constructor(
    private readonly host: CommandHost,
    private readonly remember = 50,
  ) {}

  /** Whether an envelope is a command that needs an ack. */
  static isCommand(env: Envelope): boolean {
    return !EVENTS.has(env.type);
  }

  /**
   * Handles a command and returns its ack, or null for events. The caller
   * sends `{id, type: "ack", payload}` when the envelope has an id.
   */
  handle(env: Envelope): AckPayload | null {
    if (!CommandProcessor.isCommand(env)) return null;
    if (env.id) {
      const cached = this.done.get(env.id);
      if (cached) return cached;
    }
    let ack: AckPayload;
    try {
      ack = this.execute(env);
    } catch {
      ack = fail("failed");
    }
    if (env.id) this.store(env.id, ack);
    return ack;
  }

  private store(id: string, ack: AckPayload) {
    this.done.set(id, ack);
    while (this.done.size > this.remember) {
      const oldest = this.done.keys().next().value as string;
      this.done.delete(oldest);
    }
  }

  /** Playback the user would lose (a film/episode, or a YouTube video). */
  private busy(): boolean {
    return !!this.host.playback() || !!this.host.busy?.();
  }

  private execute(env: Envelope): AckPayload {
    const sender = senderName(env.from);
    switch (env.type) {
      case "media.open": {
        const req = parseOpen(env.payload);
        if (!req) return fail("bad_payload");
        const screen = this.host.screen();
        if (screen === "profiles") {
          this.host.queue(strip(req), sender);
          return { ok: true, result: { queued: true } };
        }
        if (!CATALOG.has(screen)) return fail("failed");
        // Never interrupt playback without the user's confirmation.
        if (this.busy() && !req.force) return fail("busy_playing");
        return { ok: true, result: this.host.open(strip(req), sender) };
      }
      case "device.show_message": {
        const text = parseMessage(env.payload);
        if (text === null) return fail("bad_payload");
        this.host.showMessage(text, sender);
        return { ok: true };
      }
      case "device.request_state":
        return { ok: true, result: this.host.state() };
      case "media.play": {
        const req = parsePlay(env.payload);
        if (!req) return fail("bad_payload");
        const screen = this.host.screen();
        if (screen === "profiles") {
          this.host.queuePlay(stripPlay(req), sender);
          return { ok: true, result: { queued: true } };
        }
        if (!CATALOG.has(screen)) return fail("failed");
        if (this.busy() && !req.force && !this.host.loading?.()) return fail("busy_playing");
        const r = this.host.play(stripPlay(req), sender);
        return typeof r === "string" ? fail(r) : { ok: true, result: r };
      }
      case "iptv.play": {
        const req = parseLive(env.payload);
        if (!req) return fail("bad_payload");
        if (!this.host.playLive) return fail("unsupported");
        if (!CATALOG.has(this.host.screen())) return fail("failed");
        // A film/episode playing: ask the user first (like media.play).
        if (this.busy() && !req.force) return fail("busy_playing");
        const out: LiveRequest = { channel_id: req.channel_id };
        if (req.profile_id) out.profile_id = req.profile_id;
        const r = this.host.playLive(out, sender);
        return typeof r === "string" ? fail(r) : { ok: true, result: r };
      }
      case "video.play": {
        const req = parseVideoPlay(env.payload);
        if (!req) return fail("bad_payload");
        if (!this.host.playVideo) return fail("unsupported");
        if (!CATALOG.has(this.host.screen())) return fail("failed");
        // A film or another video playing: ask the user first (like media.play).
        if (this.busy() && !req.force) return fail("busy_playing");
        const out: VideoPlayRequest = { video_id: req.video_id };
        if (req.profile_id) out.profile_id = req.profile_id;
        if (req.position_seconds !== undefined) out.position_seconds = req.position_seconds;
        if (req.quality) out.quality = req.quality;
        const r = this.host.playVideo(out, sender);
        return typeof r === "string" ? fail(r) : { ok: true, result: r };
      }
      case "playback.set_volume": {
        const change = parseVolume(env.payload);
        if (!change) return fail("bad_payload");
        if (!this.host.volume) return fail("unsupported");
        const r = this.host.volume(change);
        return typeof r === "string" ? fail(r) : { ok: true, result: r };
      }
      case "media.pause":
      case "media.resume":
      case "media.stop":
      case "media.seek":
      case "media.next_episode":
      case "media.select_source":
      case "playback.set_audio":
      case "playback.set_subtitles": {
        const c = parseControl(env.type, env.payload);
        if (!c) return fail("bad_payload");
        if (!CATALOG.has(this.host.screen())) return fail("failed");
        const r = this.host.control(c);
        return typeof r === "string" ? fail(r) : { ok: true, result: r };
      }
      default:
        return fail("unsupported");
    }
  }
}

function stripPlay(req: PlayRequest & { force?: boolean }): PlayRequest {
  const out: PlayRequest = { media_id: req.media_id };
  if (req.episode_id !== undefined) out.episode_id = req.episode_id;
  if (req.source_id !== undefined) out.source_id = req.source_id;
  if (req.release_id !== undefined) out.release_id = req.release_id;
  if (req.quality !== undefined) out.quality = req.quality;
  if (req.position_seconds !== undefined) out.position_seconds = req.position_seconds;
  if (req.player !== undefined) out.player = req.player;
  return out;
}

function strip(req: OpenRequest & { force?: boolean }): OpenRequest {
  const out: OpenRequest = { media_id: req.media_id };
  if (req.season_number !== undefined) out.season_number = req.season_number;
  if (req.episode_number !== undefined) out.episode_number = req.episode_number;
  return out;
}

// What the TV reports to controllers as `device.state` (see openapi DeviceState).
import type { DeviceState, MediaKind, PlaybackState, PlayerKind } from "@martytv/contracts";
import type { Route } from "../catalog/nav";

export type TvScreen = DeviceState["screen"];

/** What the Details screen knows about its title (reported once it has data). */
export interface DetailsInfo {
  title: string | null;
  poster_path: string | null;
  kind: MediaKind | null;
  /** Selected season on a series' Details. */
  season_number: number | null;
}

export interface StateInput {
  /** App-level screen; "catalog" means the signed-in area (route decides). */
  screen: Exclude<TvScreen, "home" | "search" | "browse" | "details" | "player"> | "catalog";
  route?: Route;
  profile?: { id: string; name: string } | null;
  /** Info for the Details on top of the stack, if it reported any. */
  details?: DetailsInfo | null;
  playback?: PlaybackState | null;
  /** Set while the player (preparing / playing / failed) covers the catalog. */
  player?: PlayerInfo | null;
  /** The player screen shows a failure: its code (DeviceState.player_error). */
  playerError?: string | null;
  /** Players available on this TV and its default (null = ask every time). */
  players?: { available: PlayerKind[]; default: PlayerKind | null };
  /** Set while live TV (IPTV) plays: reported as the player screen with `live`. */
  live?: LiveInfo | null;
  /** Set while a «Видео» (YouTube) video plays: reported as the player screen with its title. */
  video?: VideoInfo | null;
  /** The TV's sound level (playback.set_volume), reported on every screen. */
  audio?: AudioInfo;
}

/** DeviceState.volume / muted / volume_source / system_volume. */
export interface AudioInfo {
  volume: number;
  muted: boolean;
  source: "system" | "app";
  /** The Tizen audio API probe: ok / absent / denied / error:<name>. */
  system: string;
}

/** The YouTube video on screen (no catalog id: media_id and playback stay null) = DeviceState.video. */
export type VideoInfo = NonNullable<DeviceState["video"]>;

/** The live channel on screen (DeviceState.live). */
export type LiveInfo = NonNullable<DeviceState["live"]>;

/** What the player shows, for the device state's title fields. */
export interface PlayerInfo {
  media_id: string;
  kind: MediaKind | null;
  title: string | null;
  poster_path: string | null;
  season_number: number | null;
}

const EMPTY = { media_id: null, kind: null, title: null, poster_path: null, season_number: null } as const;

export function buildDeviceState(input: StateInput): DeviceState {
  const signedIn = input.screen === "catalog" && !!input.profile;
  const base = {
    profile_id: signedIn ? input.profile!.id : null,
    profile_name: signedIn ? input.profile!.name : null,
    playback: input.playback ?? null,
    ...(input.players ? { players: input.players.available, default_player: input.players.default } : {}),
    ...(input.audio
      ? { volume: input.audio.volume, muted: input.audio.muted, volume_source: input.audio.source, system_volume: input.audio.system.slice(0, 64) }
      : {}),
  };
  if (input.screen === "catalog" && input.live) {
    return { screen: "player", ...EMPTY, ...base, playback: null, live: input.live };
  }
  if (input.screen === "catalog" && input.video) {
    return { screen: "player", ...EMPTY, ...base, title: input.video.title, playback: null, video: input.video };
  }
  if (input.screen === "catalog" && input.player) {
    const p = input.player;
    return {
      screen: "player",
      media_id: p.media_id,
      kind: p.kind,
      title: p.title || null,
      poster_path: p.poster_path,
      season_number: p.season_number,
      ...base,
      ...(input.playerError ? { player_error: input.playerError.slice(0, 64) } : {}),
    };
  }
  if (input.screen !== "catalog" || !input.route) {
    return { screen: input.screen === "catalog" ? "home" : input.screen, ...EMPTY, ...base };
  }
  const route = input.route;
  switch (route.name) {
    case "details": {
      const info = input.details;
      const preview = route.preview;
      return {
        screen: "details",
        media_id: route.id,
        kind: info?.kind ?? preview?.kind ?? null,
        title: info?.title ?? preview?.title ?? null,
        poster_path: info?.poster_path ?? preview?.poster_path ?? null,
        season_number: info ? info.season_number : (route.season ?? null),
        ...base,
      };
    }
    case "browse":
      return { screen: "browse", ...EMPTY, kind: route.kind, ...base };
    case "mine":
    case "messages":
    case "tv":
    case "video":
    case "video-search":
    case "video-channel":
    case "explore":
    case "surprise":
    case "ask":
    case "history":
    case "new-episodes":
    case "tile":
    case "collection":
    case "curated":
    case "person":
    case "tv-day":
      // Not in the device-state contract: reported as Home.
      return { screen: "home", ...EMPTY, ...base };
    default:
      return { screen: route.name, ...EMPTY, ...base };
  }
}

/** Stable comparison key, so identical states aren't re-sent. */
export function stateKey(s: DeviceState): string {
  return JSON.stringify(s);
}

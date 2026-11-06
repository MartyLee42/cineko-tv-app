// Which player opens a stream (like Lampa): Cineko's HTML5 player, Media
// Station X's native player, or an external Android app. Pure apart from
// the stores at the bottom.
import type { PlaybackSource, PlayerKind } from "@martytv/contracts";
import { detectPlatform, storage } from "../platform";
import { bridgeAvailable, bridgeCanLaunch } from "./msx";

/** External Android apps offered in the chooser. */
export type ExternalApp = "system" | "vlc" | "mx";

export const EXTERNAL_PACKAGES: Record<ExternalApp, string | null> = {
  system: null,
  vlc: "org.videolan.vlc",
  mx: "com.mxtech.videoplayer.ad",
};

/** A concrete choice: the player, plus the app for "external". */
export interface PlayerChoice {
  player: PlayerKind;
  app?: ExternalApp;
}

export interface PlayerEnv {
  platform: string;
  /** The MSX bridge heartbeat is live (MSX hosts this app). */
  msxAlive: boolean;
  /** The bridge can run system:tvx:launch (MSX ≥ 0.1.136 on Android / Fire TV). */
  msxLaunch?: boolean;
  /** navigator.userAgent (WebView / MSX markers). */
  ua?: string;
}

/** How an external Android app is opened here: intent:// (Chrome), MSX's launch action, or not at all. */
export type ExternalRoute = "intent" | "msx" | null;

/** Android System WebView (`; wv)` in the UA): intent:// URLs fail ("unsupported uri scheme"). */
export function isWebView(ua: string): boolean {
  return /Android/.test(ua) && /[;(]\s*wv[;)]/.test(ua);
}

/** Whether this page runs inside Media Station X (bridge alive, or MSX in the UA). */
export function insideMsx(env: PlayerEnv): boolean {
  return env.msxAlive || /MSX|Media ?Station/i.test(env.ua ?? "");
}

/**
 * The external-app route: inside MSX only through the bridge's launch
 * action; outside MSX only in a real Android browser (Chrome), where
 * intent:// works — never in a WebView, never on Tizen/webOS.
 */
export function externalRoute(env: PlayerEnv): ExternalRoute {
  if (insideMsx(env)) return env.msxAlive && env.msxLaunch ? "msx" : null;
  if (env.platform !== "android-tv") return null;
  if (isWebView(env.ua ?? "")) return null;
  return "intent";
}

/** True where the chooser should explain why there are no external apps (MSX without launch support). */
export function externalHiddenInMsx(env: PlayerEnv): boolean {
  return insideMsx(env) && externalRoute(env) === null;
}

/** Players this TV can use: built-in always, MSX while its bridge runs, external where it really opens. */
export function availablePlayers(env: PlayerEnv): PlayerKind[] {
  const out: PlayerKind[] = ["builtin"];
  if (env.msxAlive) out.push("msx");
  if (externalRoute(env)) out.push("external");
  return out;
}

export type Resolution = { player: PlayerKind } | { ask: true } | { error: "unsupported" };

/**
 * The player for a play request: the requested one (must be available), else
 * the TV's default when available, else built-in when it's the only one,
 * else ask the user.
 */
export function resolvePlayer(requested: PlayerKind | null | undefined, def: PlayerKind | null, available: readonly PlayerKind[]): Resolution {
  if (requested) return available.includes(requested) ? { player: requested } : { error: "unsupported" };
  if (def && available.includes(def)) return { player: def };
  if (available.length <= 1) return { player: "builtin" };
  return { ask: true };
}

const MIME_EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/x-matroska": "mkv",
  "video/webm": "webm",
  "video/mp2t": "ts",
  "video/x-msvideo": "avi",
  "video/quicktime": "mov",
};

/** File name for the stream URL (lets external players detect the container). */
export function streamFileName(src: Pick<PlaybackSource, "file" | "mime_type">): string {
  const path = src.file?.path ?? "";
  const base = path.split(/[\\/]/).pop()?.trim();
  if (base) return base;
  const ext = MIME_EXT[(src.mime_type ?? "").split(";")[0]!.trim()] ?? "mkv";
  return `video.${ext}`;
}

/** Absolute `/api/v1/stream/{token}/{filename}` URL for MSX / external apps. */
export function absoluteStreamUrl(src: Pick<PlaybackSource, "file" | "mime_type" | "stream_url">, origin: string): string | null {
  if (!src.stream_url) return null;
  const base = /^https?:\/\//.test(src.stream_url) ? src.stream_url : `${origin}${src.stream_url}`;
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(streamFileName(src))}`;
}

/** Android intent URL opening `url` in a video app (system chooser without a package). */
export function intentUrl(url: string, title: string, mime: string | null, app: ExternalApp = "system"): string {
  const m = /^(https?):\/\/(.*)$/.exec(url);
  const scheme = m ? m[1]! : "http";
  const rest = m ? m[2]! : url;
  const pkg = EXTERNAL_PACKAGES[app];
  const type = mime && mime.startsWith("video/") ? mime.split(";")[0]!.trim() : "video/*";
  return (
    `intent://${rest}#Intent;scheme=${scheme};action=android.intent.action.VIEW;type=${type};` +
    `S.title=${encodeURIComponent(title)};${pkg ? `package=${pkg};` : ""}end`
  );
}

const DEFAULT_KEY = "martytv.default_player";
const KINDS: readonly PlayerKind[] = ["builtin", "msx", "external"];

/** The TV's default player (per device, localStorage); null = ask every time. */
export const defaultPlayerStore = {
  get(): PlayerKind | null {
    const v = storage.get(DEFAULT_KEY);
    return v && (KINDS as readonly string[]).includes(v) ? (v as PlayerKind) : null;
  },
  set(v: PlayerKind | null) {
    if (v) storage.set(DEFAULT_KEY, v);
    else storage.set(DEFAULT_KEY, "ask");
  },
};

/** This TV's environment right now. */
export function currentEnv(): PlayerEnv {
  return { platform: detectPlatform(), msxAlive: bridgeAvailable(), msxLaunch: bridgeCanLaunch(), ua: typeof navigator !== "undefined" ? navigator.userAgent : "" };
}

/** Players available right now on this TV. */
export function currentPlayers(): PlayerKind[] {
  return availablePlayers(currentEnv());
}

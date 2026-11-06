// Player choice (pure): which TV player opens a stream, and which apps can
// play a stream on this phone/computer (Lampa-style "external players").
import type { DeviceState, PlaybackSource, PlayerKind } from "@martytv/contracts";

// ---------------------------------------------------------------- TV players

export const PLAYER_KINDS: PlayerKind[] = ["builtin", "msx", "external"];

export type PlayerDecision =
  | { kind: "use"; player?: PlayerKind } // undefined → the TV's own default
  | { kind: "ask"; options: PlayerKind[]; preselected: PlayerKind };

/**
 * Whether to ask which TV player to use.
 * - an explicit `requested` player wins;
 * - a TV with a single player (or an older TV that doesn't report players) never asks;
 * - a TV with a default player uses it, unless the user asked to choose ("Play with…");
 * - otherwise ask, preselecting the TV default, else the last choice for that TV.
 */
export function decidePlayer(
  state: DeviceState | null | undefined,
  remembered: PlayerKind | null,
  opts: { force?: boolean; requested?: PlayerKind } = {},
): PlayerDecision {
  if (opts.requested) return { kind: "use", player: opts.requested };
  const options = PLAYER_KINDS.filter((k) => state?.players?.includes(k));
  if (options.length <= 1) return { kind: "use", player: options[0] };
  const def = state?.default_player && options.includes(state.default_player) ? state.default_player : null;
  if (def && !opts.force) return { kind: "use", player: def };
  const preselected = def ?? (remembered && options.includes(remembered) ? remembered : options[0]!);
  return { kind: "ask", options, preselected };
}

const playerKey = (deviceId: string) => `martytv.player.${deviceId}`;

export function rememberedPlayer(deviceId: string): PlayerKind | null {
  try {
    const v = localStorage.getItem(playerKey(deviceId));
    return PLAYER_KINDS.includes(v as PlayerKind) ? (v as PlayerKind) : null;
  } catch {
    return null;
  }
}

export function rememberPlayer(deviceId: string, p: PlayerKind) {
  try {
    localStorage.setItem(playerKey(deviceId), p);
  } catch {
    // private mode: not remembered
  }
}

// ---------------------------------------------------------------- players on this device

export type Platform = "ios" | "android" | "desktop";
export type LocalPlayer = "vlc" | "intent" | "m3u" | "copy";
/** Account setting: what "On this device" does by default. */
export type LocalDefault = "ask" | "vlc" | "intent" | "m3u";

export function detectPlatform(ua: string, maxTouchPoints = 0): Platform {
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  // iPadOS reports itself as a Mac; touch points give it away.
  if (/macintosh/i.test(ua) && maxTouchPoints > 1) return "ios";
  return "desktop";
}

/**
 * Options that work on this platform. "another app" is an Android intent;
 * vlc:// is registered by the VLC apps on phones only (desktop VLC doesn't
 * claim it, so the OS says "no app can open this"), so computers get the
 * playlist file and the link to paste into a player.
 */
export function localOptions(platform: Platform): LocalPlayer[] {
  if (platform === "android") return ["vlc", "intent", "m3u", "copy"];
  if (platform === "ios") return ["vlc", "m3u", "copy"];
  return ["m3u", "copy"];
}

/** The account default first (when available here), then the rest. */
export function orderLocalOptions(platform: Platform, def: LocalDefault): { primary: LocalPlayer | null; rest: LocalPlayer[] } {
  const all = localOptions(platform);
  const primary = def !== "ask" && all.includes(def) ? def : null;
  return { primary, rest: all.filter((o) => o !== primary) };
}

const EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/x-matroska": "mkv",
  "video/webm": "webm",
  "video/mp2t": "ts",
  "video/x-msvideo": "avi",
};

/** File name for the stream URL so players can sniff the container. */
export function streamFileName(source: Pick<PlaybackSource, "file" | "mime_type">, title: string): string {
  const base = source.file?.path.split(/[\\/]/).pop();
  if (base) return base;
  const ext = (source.mime_type && EXT[source.mime_type]) || "mkv";
  return `${safeName(title)}.${ext}`;
}

export function safeName(title: string): string {
  const printable = [...title].map((c) => (c < " " ? " " : c)).join("");
  return printable.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "video";
}

/** Absolute stream URL with a trailing file name: origin + /api/v1/stream/<token>/<name>. */
export function absoluteStreamUrl(streamUrl: string, fileName: string, origin: string): string {
  const path = `${streamUrl.replace(/\/+$/, "")}/${encodeURIComponent(fileName)}`;
  return /^https?:\/\//i.test(path) ? path : `${origin.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function vlcUrl(url: string): string {
  return `vlc://${url}`;
}

export function intentUrl(url: string, title: string): string {
  return `intent:${url}#Intent;action=android.intent.action.VIEW;type=video/*;S.title=${encodeURIComponent(title)};end`;
}

export function m3u(url: string, title: string): string {
  return `#EXTM3U\n#EXTINF:-1,${title.replace(/[\r\n]+/g, " ")}\n${url}\n`;
}

const LOCAL_KEY = "martytv.local_player";
export const LOCAL_DEFAULTS: LocalDefault[] = ["ask", "vlc", "intent", "m3u"];

export function readLocalDefault(): LocalDefault {
  try {
    const v = localStorage.getItem(LOCAL_KEY);
    return LOCAL_DEFAULTS.includes(v as LocalDefault) ? (v as LocalDefault) : "ask";
  } catch {
    return "ask";
  }
}

export function writeLocalDefault(v: LocalDefault) {
  try {
    localStorage.setItem(LOCAL_KEY, v);
  } catch {
    // private mode: not remembered
  }
}

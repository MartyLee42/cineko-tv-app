// Remote keys inside the player: arrows/OK, Back and media keys across TV
// platforms (browser `key` names and Tizen/webOS key codes).
import { isBackKey } from "../platform";

export type PlayerKey =
  | "ok"
  | "left"
  | "right"
  | "up"
  | "down"
  | "back"
  | "playpause"
  | "play"
  | "pause"
  | "stop"
  | "ff"
  | "rew"
  | "next"
  | "prev"
  /** Channel / Page ▲▼: jump to the tabs, next section (catalog only). */
  | "chup"
  | "chdown"
  /** INFO / GUIDE: the live channel's programme (live TV only). */
  | "guide";

const BY_KEY: Record<string, PlayerKey> = {
  Enter: "ok",
  ArrowLeft: "left",
  Left: "left",
  ArrowRight: "right",
  Right: "right",
  ArrowUp: "up",
  Up: "up",
  ArrowDown: "down",
  Down: "down",
  Info: "guide",
  Guide: "guide",
  MediaPlayPause: "playpause",
  " ": "playpause",
  MediaPlay: "play",
  Play: "play",
  MediaPause: "pause",
  Pause: "pause",
  MediaStop: "stop",
  Stop: "stop",
  MediaFastForward: "ff",
  FastFwd: "ff",
  FastForward: "ff",
  MediaRewind: "rew",
  Rewind: "rew",
  MediaTrackNext: "next",
  MediaNextTrack: "next",
  MediaTrackPrevious: "prev",
  MediaPreviousTrack: "prev",
  PageUp: "chup",
  ChannelUp: "chup",
  PageDown: "chdown",
  ChannelDown: "chdown",
};

const BY_CODE: Record<number, PlayerKey> = {
  13: "ok",
  37: "left",
  38: "up",
  39: "right",
  40: "down",
  179: "playpause", // browsers / Android TV
  10252: "playpause", // Tizen MediaPlayPause
  415: "play", // Tizen, webOS, HbbTV
  250: "play", // some older LG/Philips remotes
  19: "pause",
  413: "stop",
  178: "stop", // browser MediaStop
  417: "ff",
  412: "rew",
  176: "next", // browser MediaTrackNext
  10233: "next", // Tizen
  177: "prev",
  10232: "prev",
  33: "chup", // PageUp; webOS ChannelUp
  34: "chdown",
  457: "guide", // Info (Tizen, webOS)
  458: "guide", // Guide (Tizen)
  427: "chup", // Tizen ChannelUp
  428: "chdown",
};

type KeyLike = Pick<KeyboardEvent, "key" | "keyCode" | "target">;

/** The player action for a key event, or null for keys the player ignores. */
export function playerKey(e: KeyLike): PlayerKey | null {
  if (isBackKey(e as KeyboardEvent)) return "back";
  // `key` first: it's unambiguous where engines provide it (e.g. keyCode 19
  // is also "Pause" on a PC keyboard, which is fine).
  if (e.key && e.key !== "Unidentified" && BY_KEY[e.key]) return BY_KEY[e.key]!;
  return BY_CODE[e.keyCode] ?? null;
}

/** Media keys a Tizen app must register to receive them. */
export const TIZEN_MEDIA_KEYS = [
  "MediaPlayPause",
  "MediaPlay",
  "MediaPause",
  "MediaStop",
  "MediaFastForward",
  "MediaRewind",
  "MediaTrackNext",
  "MediaTrackPrevious",
  "ChannelUp",
  "ChannelDown",
  "Info",
  "Guide",
];

/** Registers media keys on Tizen (no-op elsewhere). Returns an unregister. */
export function registerMediaKeys(): () => void {
  const tv = (window as unknown as { tizen?: { tvinputdevice?: { registerKey(k: string): void; unregisterKey(k: string): void } } }).tizen
    ?.tvinputdevice;
  if (!tv) return () => undefined;
  const done: string[] = [];
  for (const k of TIZEN_MEDIA_KEYS) {
    try {
      tv.registerKey(k);
      done.push(k);
    } catch {
      // key not supported by this model
    }
  }
  return () => {
    for (const k of done) {
      try {
        tv.unregisterKey(k);
      } catch {
        // ignore
      }
    }
  };
}

export const SEEK_BACK = 10;
export const SEEK_FWD = 30;

/**
 * Seconds one press moves while seeking: −10/+30 s, growing while the key is
 * held (auto-repeat) or pressed quickly in a row: ×2 after 4, ×4 after 10, ×8
 * after 20 steps.
 */
export function seekStep(dir: -1 | 1, count: number): number {
  const base = dir < 0 ? SEEK_BACK : SEEK_FWD;
  const mult = count < 4 ? 1 : count < 10 ? 2 : count < 20 ? 4 : 8;
  return dir * base * mult;
}

/** Accumulated seek preview (where the playhead will land). */
export interface SeekPreview {
  target: number;
  count: number;
  dir: -1 | 1;
}

/**
 * Applies one more seek press. Reversing direction restarts the acceleration.
 * The target stays in [0, duration] (end stays a little before the end so
 * seeking forward never triggers "ended" by accident).
 */
export function accumulateSeek(prev: SeekPreview | null, from: number, dir: -1 | 1, duration: number | null): SeekPreview {
  const sameDir = prev && prev.dir === dir;
  const count = sameDir ? prev.count + 1 : 0;
  const start = prev ? prev.target : from;
  let target = start + seekStep(dir, count);
  const max = duration && isFinite(duration) && duration > 0 ? Math.max(0, duration - 3) : Infinity;
  target = Math.max(0, Math.min(max, target));
  return { target, count, dir };
}

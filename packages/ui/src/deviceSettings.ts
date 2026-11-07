// Settings per device (docs/architecture.md «Device settings»): a profile's
// look and playback behaviour can differ on each TV and on the browser
// classes «Компьютер» / «Телефон». The server merges the layers
// (services/api/internal/profiles/layers.go — keep LAYERED_KEYS identical);
// this module holds the shared lists, the defaults of a TV's own options,
// the class detection for browsers and a pure mirror of the merge.

/** Settings that live per device class / per TV; everything else is per profile. */
export const LAYERED_KEYS = [
  "theme",
  "design",
  "design_surprise",
  "design_favorites",
  "loading_style",
  "seasonal_effects",
  "cozy_mode",
  "cozy_ambience",
  "cozy_sound",
  "poster_wobble",
  "hidden_tabs",
  "autoplay_next_episode",
  "autoplay_countdown",
  "skip_segments",
  "video_autoplay",
] as const;
export type LayeredKey = (typeof LAYERED_KEYS)[number];

export function isLayeredKey(k: string): k is LayeredKey {
  return (LAYERED_KEYS as readonly string[]).includes(k);
}

/**
 * Effective settings: base, then each layer's layered keys over it (later
 * wins; null / undefined = not set). Validation stays on the server.
 */
export function mergeLayers<T extends object>(base: T, ...layers: (Partial<T> | null | undefined)[]): T {
  const out = { ...base } as Record<string, unknown>;
  for (const l of layers) {
    if (!l) continue;
    for (const [k, v] of Object.entries(l)) if (isLayeredKey(k) && v !== undefined && v !== null) out[k] = v;
  }
  return out as T;
}

/** Splits a patch into its per-profile and per-device parts. */
export function splitPatch<T extends object>(patch: Partial<T>): { base: Partial<T>; layer: Partial<T> } {
  const base: Record<string, unknown> = {};
  const layer: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) (isLayeredKey(k) ? layer : base)[k] = v;
  return { base: base as Partial<T>, layer: layer as Partial<T> };
}

// ---------------------------------------------------------------- a TV's own options

export type SaverSetting = "sleep" | "dvd" | "off";
export const SAVER_SETTINGS: readonly SaverSetting[] = ["sleep", "dvd", "off"];

/** contract TvDeviceSettings (absent = not set yet). */
export interface TvOwnSettings {
  screensaver?: SaverSetting;
  ui_sounds?: boolean;
  startup_intro?: boolean;
  calm_motion?: boolean;
  language?: "ru" | "en" | "kk";
  health_report?: boolean;
  slow_hint?: boolean;
  show_prebuffer?: boolean;
  speedtest?: boolean;
}
export type TvOwnKey = keyof TvOwnSettings;

/** Defaults of a TV's own options (language: the TV's detected one). */
export const TV_OWN_DEFAULTS: Required<Omit<TvOwnSettings, "language">> = {
  screensaver: "sleep",
  ui_sounds: false,
  startup_intro: true,
  calm_motion: false,
  health_report: true,
  slow_hint: false,
  show_prebuffer: false,
  speedtest: true,
};
export const TV_OWN_KEYS: readonly TvOwnKey[] = ["screensaver", "ui_sounds", "startup_intro", "calm_motion", "language", "health_report", "slow_hint", "show_prebuffer", "speedtest"];

/** The TV's options with defaults filled (what a phone shows for a TV). */
export function withTvOwnDefaults(s: TvOwnSettings | null | undefined, language: NonNullable<TvOwnSettings["language"]> = "ru"): Required<TvOwnSettings> {
  return { ...TV_OWN_DEFAULTS, language, ...stripNull(s ?? {}) };
}

/** Keys the server doesn't have yet, from the TV's local values (the one-time seed). */
export function seedPatch(server: TvOwnSettings | null | undefined, local: TvOwnSettings): TvOwnSettings {
  const out: Record<string, unknown> = {};
  for (const k of TV_OWN_KEYS) {
    if ((server?.[k] === undefined || server?.[k] === null) && local[k] !== undefined) out[k] = local[k];
  }
  return out as TvOwnSettings;
}

function stripNull<T extends object>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined) out[k] = v;
  return out as Partial<T>;
}

// ---------------------------------------------------------------- browser class

/** «Компьютер» or «Телефон» (a browser's settings class). */
export type DeviceClass = "desktop" | "mobile";
export const DEVICE_CLASSES: readonly DeviceClass[] = ["desktop", "mobile"];

export interface ClassEnv {
  ua: string;
  /** matchMedia("(pointer: coarse)") and no fine pointer. */
  coarse: boolean;
  /** Screen size in CSS px (either orientation). */
  width: number;
  height: number;
}

/**
 * Phones and tablets are «Телефон»; laptops and desktops «Компьютер». Decided
 * once per browser (the PWA stores it) so a resized window never flips it.
 */
export function detectDeviceClass(env: ClassEnv): DeviceClass {
  if (/Mobi|iPhone|iPod|Android|iPad|Tablet|Silk|Kindle|Windows Phone/i.test(env.ua)) return "mobile";
  // iPadOS reports a Mac: touch-only with a tablet-sized screen.
  if (env.coarse && Math.min(env.width, env.height) > 0 && Math.min(env.width, env.height) < 1100) return "mobile";
  return "desktop";
}

export function parseDeviceClass(v: string | null | undefined): DeviceClass | null {
  return v === "desktop" || v === "mobile" ? v : null;
}

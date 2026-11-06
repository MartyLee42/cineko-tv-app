// The TV's sound level for playback.set_volume (phone remote → TV).
//
// Two backends:
//  - "system": Samsung Tizen's TV Audio Control API (`tizen.tvaudiocontrol`)
//    changes the TV's real volume — only when the page can reach it (Cineko
//    runs inside MSX's Tizen app: `window.tizen` may be missing, or the
//    tv.audio privilege absent → SecurityError). Probed once at startup.
//  - "app": the volume of Cineko's own media elements (0–100 % of whatever
//    the TV is set to) and their mute, kept per TV in localStorage so a new
//    film doesn't start at full blast again.
// Pure helpers + a small store; the players register their <video> elements.

/** The level as reported to phones (DeviceState.volume / muted). */
export interface AudioLevel {
  /** 0..1 */
  volume: number;
  muted: boolean;
}

/** A validated playback.set_volume (at least one field). */
export interface VolumeChange {
  /** Absolute level 0..1 (wins over delta). */
  volume?: number;
  /** Relative step −1..1 (snapped to the step grid, e.g. 10 %). */
  delta?: number;
  muted?: boolean;
}

/** What the probe of Tizen's audio API found. */
export type SystemVolumeStatus = "ok" | "absent" | "denied" | `error:${string}`;
export type VolumeSource = "system" | "app";

export const VOLUME_KEY = "martytv.volume";
export const VOLUME_STEP = 0.1;
const FULL: AudioLevel = { volume: 1, muted: false };

/** 0..1, rounded to whole percent; anything not a number = full. */
export function clampVolume(v: unknown): number {
  if (typeof v !== "number" || !isFinite(v)) return 1;
  return Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
}

/**
 * A relative step from `cur`: an off-grid level snaps to the grid of |delta|
 * first, so 55 % + 10 % = 60 % (not 65 %) and 55 % − 10 % = 50 %.
 */
export function stepVolume(cur: number, delta: number): number {
  const c = clampVolume(cur);
  const step = Math.abs(delta);
  if (!step) return c;
  const units = c / step;
  const eps = 1e-6;
  const base = delta > 0 ? Math.floor(units + eps) : Math.ceil(units - eps);
  return clampVolume((base + Math.sign(delta)) * step);
}

/** The level after a change. Changing the volume (without `muted`) unmutes, like a TV's own buttons. */
export function applyVolumeChange(cur: AudioLevel, c: VolumeChange): AudioLevel {
  let volume = cur.volume;
  if (typeof c.volume === "number") volume = clampVolume(c.volume);
  else if (typeof c.delta === "number") volume = stepVolume(cur.volume, c.delta);
  const touched = typeof c.volume === "number" || typeof c.delta === "number";
  const muted = typeof c.muted === "boolean" ? c.muted : touched ? false : cur.muted;
  return { volume, muted };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates a playback.set_volume payload (the server validates too; be defensive). */
export function parseVolume(p: unknown): VolumeChange | null {
  if (!isObject(p)) return null;
  const out: VolumeChange = {};
  const { volume, delta, muted } = p;
  if (volume !== undefined && volume !== null) {
    if (typeof volume !== "number" || !isFinite(volume) || volume < 0 || volume > 1) return null;
    out.volume = volume;
  }
  if (delta !== undefined && delta !== null) {
    if (typeof delta !== "number" || !isFinite(delta) || delta < -1 || delta > 1) return null;
    out.delta = delta;
  }
  if (muted !== undefined && muted !== null) {
    if (typeof muted !== "boolean") return null;
    out.muted = muted;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The saved app level (anything broken = full volume, unmuted). */
export function readSaved(raw: string | null): AudioLevel {
  try {
    const v = JSON.parse(raw ?? "null") as { volume?: unknown; muted?: unknown } | null;
    if (!isObject(v)) return { ...FULL };
    return { volume: clampVolume(v.volume ?? 1), muted: v.muted === true };
  } catch {
    return { ...FULL };
  }
}

// ---------------------------------------------------------------- Tizen

/** The part of `tizen.tvaudiocontrol` we use (all calls may throw). */
export interface TvAudioControl {
  getVolume(): number;
  setVolume(v: number): void;
  setVolumeUp?(): void;
  setVolumeDown?(): void;
  setMute(m: boolean): void;
  isMute(): boolean;
  setVolumeChangeListener?(cb: (v: number) => void): void;
  unsetVolumeChangeListener?(): void;
}

function errorName(e: unknown): string {
  const n = isObject(e) || e instanceof Error ? (e as { name?: unknown }).name : null;
  return typeof n === "string" && n ? n.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "Error" : "Error";
}

/** A thrown error as a probe status (SecurityError = the privilege is missing). */
function failure(e: unknown): SystemVolumeStatus {
  const name = errorName(e);
  return name === "SecurityError" ? "denied" : `error:${name}`;
}

/** Finds and tries Tizen's audio API: `ok` (with the API), `absent`, `denied` (no privilege) or `error:<name>`. */
export function probeSystemVolume(win: unknown): { status: SystemVolumeStatus; api: TvAudioControl | null } {
  let tac: unknown;
  try {
    tac = (win as { tizen?: { tvaudiocontrol?: unknown } } | null)?.tizen?.tvaudiocontrol;
  } catch (e) {
    return { status: failure(e), api: null };
  }
  if (!isObject(tac) || typeof tac.getVolume !== "function" || typeof tac.setVolume !== "function") return { status: "absent", api: null };
  try {
    const v = (tac as unknown as TvAudioControl).getVolume();
    if (typeof v !== "number" || !isFinite(v)) return { status: "error:NoValue", api: null };
    return { status: "ok", api: tac as unknown as TvAudioControl };
  } catch (e) {
    return { status: failure(e), api: null };
  }
}

/** Which platform objects exist (for «Об этом телевизоре» / support). */
export function platformApis(win: unknown): { tizen: boolean; webapis: boolean; systeminfo: boolean } {
  try {
    const w = win as { tizen?: { systeminfo?: unknown }; webapis?: unknown };
    return { tizen: !!w?.tizen, webapis: !!w?.webapis, systeminfo: !!w?.tizen?.systeminfo };
  } catch {
    return { tizen: false, webapis: false, systeminfo: false };
  }
}

// ---------------------------------------------------------------- the store

export interface VolumeEnv {
  win: unknown;
  load(): string | null;
  save(v: string): void;
}

/** The media element bits we touch (so tests use plain objects). */
export interface MediaLike {
  volume: number;
  muted: boolean;
}

/**
 * The TV's level: the system volume when Tizen's API works, else Cineko's
 * own (applied to every registered media element). Listeners hear every
 * change: from a remote command (`remote` true) or from the TV itself.
 */
export class VolumeControl {
  private app: AudioLevel;
  private sys: TvAudioControl | null = null;
  private sysStatus: SystemVolumeStatus = "absent";
  private elements = new Set<MediaLike>();
  private listeners = new Set<(remote: boolean) => void>();

  constructor(private readonly env: VolumeEnv) {
    this.app = readSaved(safe(() => env.load(), null));
    this.probe();
  }

  /** (Re)probes Tizen's audio API; returns the status. */
  probe(): SystemVolumeStatus {
    try {
      this.sys?.unsetVolumeChangeListener?.();
    } catch {
      // ignore
    }
    const r = probeSystemVolume(this.env.win);
    this.sys = r.api;
    this.sysStatus = r.status;
    if (this.sys) {
      try {
        this.sys.setVolumeChangeListener?.(() => this.emit(false));
      } catch {
        // No listener: the state still follows our own changes.
      }
    }
    // The system volume rules: our elements play at full (no double attenuation).
    this.elements.forEach((el) => this.applyTo(el));
    return this.sysStatus;
  }

  status(): SystemVolumeStatus {
    return this.sysStatus;
  }

  source(): VolumeSource {
    return this.sys ? "system" : "app";
  }

  /** The current level (the system's when available). */
  level(): AudioLevel {
    if (this.sys) {
      try {
        const v = this.sys.getVolume();
        let muted = false;
        try {
          muted = !!this.sys.isMute();
        } catch {
          // ignore
        }
        return { volume: clampVolume(v / 100), muted };
      } catch (e) {
        this.fallBack(e);
      }
    }
    return { ...this.app };
  }

  /** Runs a playback.set_volume; returns the new level. */
  change(c: VolumeChange): AudioLevel {
    if (this.sys) {
      const cur = this.level();
      const next = applyVolumeChange(cur, c);
      try {
        if (next.volume !== cur.volume) this.sys.setVolume(Math.round(next.volume * 100));
        if (next.muted !== cur.muted) this.sys.setMute(next.muted);
        this.emit(true);
        return this.level();
      } catch (e) {
        // Lost the privilege / API mid-way: Cineko's own volume from now on.
        this.fallBack(e);
      }
    }
    this.app = applyVolumeChange(this.app, c);
    safe(() => this.env.save(JSON.stringify(this.app)), undefined);
    this.elements.forEach((el) => this.applyTo(el));
    this.emit(true);
    return { ...this.app };
  }

  /** A player's media element: gets the level now and on every change. Returns the unbind. */
  bind(el: MediaLike): () => void {
    this.elements.add(el);
    this.applyTo(el);
    return () => void this.elements.delete(el);
  }

  subscribe(l: (remote: boolean) => void): () => void {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  private applyTo(el: MediaLike) {
    const lv = this.sys ? FULL : this.app;
    try {
      if (el.volume !== lv.volume) el.volume = lv.volume;
      if (el.muted !== lv.muted) el.muted = lv.muted;
    } catch {
      // Some engines refuse volume writes; nothing to do.
    }
  }

  private fallBack(e: unknown) {
    this.sys = null;
    this.sysStatus = failure(e);
    this.elements.forEach((el) => this.applyTo(el));
  }

  private emit(remote: boolean) {
    this.listeners.forEach((l) => l(remote));
  }
}

function safe<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

/** This TV's volume (one per app). */
export const tvVolume = new VolumeControl({
  win: typeof window === "undefined" ? null : window,
  load: () => localStorage.getItem(VOLUME_KEY),
  save: (v) => localStorage.setItem(VOLUME_KEY, v),
});

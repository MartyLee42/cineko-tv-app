// This TV's playback profile («Это устройство», docs «Device playback
// profiles»): `auto` is what the TV detects itself (codecs, screen, measured
// throughput, model) and reports to the server on start / after playback;
// `manual` holds the user's overrides (here or from the phone). The server
// ranks releases with the merge; the TV keeps a cached copy for its own
// decisions (e.g. «always convert audio»). Nothing here is model-specific.
import { useSyncExternalStore } from "react";
import { unwrap, type Schemas } from "@martytv/contracts";
import { parseDeviceModel } from "@martytv/ui";
import { landscapeSize } from "@martytv/media-types";
import { api } from "../api";
import { queryClient } from "../catalog/queries";
import { detectPlatform, storage } from "../platform";
import { audioSupported, engineProbe, type Probe } from "../player/codecs";
import { canPlayCompat, compatServer } from "../player/compat";
import { rateStore } from "../player/rebuffer";
import { ensureSmoothProbe, thisSmoothView } from "../player/smooth";
import { BRIDGE_KEY, bridgeAvailable } from "../players/msx";
import { defaultPlayerStore, insideMsx } from "../players/select";

export type PlaybackPrefs = Schemas["PlaybackPrefs"];
export type PlaybackAuto = Schemas["PlaybackAuto"];
export type PlaybackManual = Schemas["PlaybackManual"];

const CACHE_KEY = "martytv.device_prefs";
const SENT_KEY = "martytv.device_prefs_sent";
/** Re-report unchanged detection at most this often. */
const REPORT_EVERY = 12 * 3600_000;

const VIDEO: [NonNullable<PlaybackAuto["video"]>[number], string[]][] = [
  ["h264", ['video/mp4; codecs="avc1.640028"', 'video/mp4; codecs="avc1.4d401f"']],
  ["hevc", ['video/mp4; codecs="hvc1.1.6.L120.90"', 'video/mp4; codecs="hev1.1.6.L120.90"', 'video/mp4; codecs="hvc1"']],
  ["vp9", ['video/webm; codecs="vp9"', 'video/mp4; codecs="vp09.00.10.08"']],
  ["av1", ['video/mp4; codecs="av01.0.08M.08"']],
  ["hdr10", ['video/mp4; codecs="hvc1.2.4.L153.B0"', 'video/webm; codecs="vp09.02.10.10.01.09.16.09.01"']],
  ["dv", ['video/mp4; codecs="dvh1.05.06"', 'video/mp4; codecs="dvhe.05.06"']],
];
/** Reported audio codecs, probed with the player's own check (codecs.ts audioSupported). */
const AUDIO: NonNullable<PlaybackAuto["audio"]>[number][] = ["aac", "ac3", "eac3", "dts", "truehd", "mp3", "opus", "flac"];
const CONTAINERS: [NonNullable<PlaybackAuto["containers"]>[number], string[]][] = [
  ["mkv", ["video/x-matroska", "video/webm"]],
  ["mp4", ["video/mp4"]],
  ["ts", ["video/mp2t"]],
];

function yes(p: Probe, types: string[]): boolean {
  for (const t of types) {
    try {
      if (p.canPlayType(t) !== "" || p.isTypeSupported?.(t)) return true;
    } catch {
      // unknown type
    }
  }
  return false;
}

/** «TX3 · Android 11 · MSX», «Samsung Tizen 6.5», «Chrome 120»… from the UA (any device). */
export function deviceModel(ua: string, msx: boolean): string {
  let base = parseDeviceModel(ua);
  if (!base) {
    const m = /Android\s*([\d.]+)?;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?[;)]/.exec(ua);
    if (m) base = [m[2]?.trim(), m[1] ? `Android ${m[1]}` : "Android"].filter(Boolean).join(" · ");
    else {
      const c = /(Chrome|Firefox|Version)\/(\d+)/.exec(ua);
      base = c ? `${c[1] === "Version" ? "Safari" : c[1]} ${c[2]}` : "";
    }
  }
  return [base, msx ? "MSX" : null].filter(Boolean).join(" · ").slice(0, 120);
}

/** What this TV can do, from its own engine (the «Об этом телевизоре» probe). */
export function detectAuto(probe: Probe = engineProbe(), env: DetectEnv = browserEnv()): PlaybackAuto {
  const size = landscapeSize(env.width ? Math.round(env.width) : null, env.height ? Math.round(env.height) : null);
  return {
    screen_width: size.width,
    screen_height: size.height,
    video: VIDEO.filter(([, t]) => yes(probe, t)).map(([k]) => k),
    audio: AUDIO.filter((k) => audioSupported(probe, k) === true),
    containers: CONTAINERS.filter(([, t]) => yes(probe, t)).map(([k]) => k),
    // Decodable but not smooth (decodingInfo / dropped frames): absent when nothing is known.
    ...(env.rough && env.rough.length > 0 ? { rough: env.rough } : {}),
    hls: yes(probe, ["application/vnd.apple.mpegurl", "application/x-mpegURL"]) || !!probe.isTypeSupported,
    compat: env.compatServer && canPlayCompat(probe),
    throughput_bps: env.throughput,
    model: deviceModel(env.ua, env.msx) || null,
    platform: env.platform,
  };
}

type DetectEnv = Omit<ReturnType<typeof browserEnv>, "rough"> & { rough?: PlaybackAuto["rough"] };

function browserEnv() {
  const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return {
    width: typeof screen !== "undefined" ? screen.width * dpr : 0,
    height: typeof screen !== "undefined" ? screen.height * dpr : 0,
    ua,
    msx: insideMsx({ platform: detectPlatform(), msxAlive: bridgeAvailable(), ua }),
    platform: detectPlatform(),
    compatServer: compatServer.get(),
    throughput: rateStore.get(),
    rough: [...thisSmoothView().rough] as NonNullable<PlaybackAuto["rough"]>,
  };
}

/** Same detection (ignores detected_at and order) — no need to re-send. */
export function sameAuto(a: PlaybackAuto | null | undefined, b: PlaybackAuto | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (x: PlaybackAuto) =>
    JSON.stringify({
      ...x,
      detected_at: null,
      video: [...(x.video ?? [])].sort(),
      audio: [...(x.audio ?? [])].sort(),
      containers: [...(x.containers ?? [])].sort(),
      rough: [...(x.rough ?? [])].sort(),
    });
  return norm(a) === norm(b);
}

// ---------------------------------------------------------------- store

type Listener = () => void;
const listeners = new Set<Listener>();
let cache: PlaybackPrefs | null | undefined;

function readCache(): PlaybackPrefs | null {
  if (cache !== undefined) return cache;
  try {
    cache = JSON.parse(storage.get(CACHE_KEY) ?? "null") as PlaybackPrefs | null;
  } catch {
    cache = null;
  }
  return cache;
}

const PLAYER_SEEN_KEY = "martytv.device_prefs_player";

function writeCache(p: PlaybackPrefs) {
  const prev = cache;
  cache = p;
  // The server ranks release lists with this profile: a new limit (first
  // measured throughput, compat learned…) must not keep serving lists
  // ranked with the old one from the 20-min cache.
  if (prev && JSON.stringify(prev.effective) !== JSON.stringify(p.effective)) {
    void queryClient.invalidateQueries({ queryKey: ["releases"] });
  }
  storage.set(CACHE_KEY, JSON.stringify(p));
  // «Плеер по умолчанию» set from the phone: becomes this TV's default
  // (only when it changed there, so a local choice isn't overwritten).
  const dp = p.manual.default_player ?? null;
  if ((storage.get(PLAYER_SEEN_KEY) ?? "") !== (dp ?? "")) {
    storage.set(PLAYER_SEEN_KEY, dp ?? "");
    if (dp) defaultPlayerStore.set(dp);
  }
  listeners.forEach((l) => l());
}

let inflight: Promise<PlaybackPrefs | null> | null = null;
/** The last sync saw MSX (bridge heartbeat or UA). */
let syncedMsx = false;
let bridgeWatch = false;
let bridgeSyncAt = 0;

/**
 * The first report goes out 3 s after start; MSX's bridge heartbeat (its
 * interaction plugin, a separate page) may not be live yet, or MSX may
 * pause it while the TV app is in front. Re-report once it shows up
 * (its heartbeat `storage` events, plus a few delayed checks), at most once a minute.
 */
function watchBridge() {
  if (bridgeWatch || typeof window === "undefined") return;
  bridgeWatch = true;
  const check = () => {
    if (syncedMsx || !bridgeAvailable() || Date.now() - bridgeSyncAt < 60_000) return;
    bridgeSyncAt = Date.now();
    void devicePrefs.sync();
  };
  try {
    window.addEventListener("storage", (e) => {
      if (e.key === BRIDGE_KEY) check();
    });
  } catch {
    // no storage events
  }
  [15_000, 45_000, 120_000].forEach((ms) => setTimeout(check, ms));
}

export const devicePrefs = {
  /** The last known profile (cached; null before the first sync). */
  get(): PlaybackPrefs | null {
    return readCache();
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /**
   * Fetches the profile and reports this TV's detection when it changed (or
   * every 12 h). Called on start and after playback; failures are quiet.
   */
  sync(force = false): Promise<PlaybackPrefs | null> {
    watchBridge();
    inflight ??= (async () => {
      try {
        const cur = await unwrap(api.GET("/devices/me/playback-prefs"));
        writeCache(cur);
        // decodingInfo answers (cached per engine; nothing without the API) go into auto.rough.
        await ensureSmoothProbe().catch(() => null);
        const env = browserEnv();
        syncedMsx = env.msx;
        const auto = detectAuto(engineProbe(), env);
        const sentAt = Number(storage.get(SENT_KEY) ?? 0);
        if (force || !sameAuto(cur.auto, auto) || Date.now() - sentAt > REPORT_EVERY) {
          const next = await unwrap(api.PATCH("/devices/me/playback-prefs", { body: { auto: { ...auto, detected_at: new Date().toISOString() } } }));
          storage.set(SENT_KEY, String(Date.now()));
          writeCache(next);
          return next;
        }
        return cur;
      } catch {
        return readCache();
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },
  /** A new throughput median after a session: re-report (quietly). */
  noteThroughput(bps: number | null) {
    const cur = readCache();
    if (!bps || (cur?.auto.throughput_bps && Math.abs(cur.auto.throughput_bps - bps) / bps < 0.1)) return;
    void this.sync(true);
  },
  /** Saves the manual overrides (TV Settings → «Это устройство»). */
  async saveManual(manual: PlaybackManual): Promise<PlaybackPrefs> {
    const next = await unwrap(api.PATCH("/devices/me/playback-prefs", { body: { manual } }));
    writeCache(next);
    return next;
  },
};

/** React: the cached profile, re-rendering on changes. */
export function useDevicePrefs(): PlaybackPrefs | null {
  return useSyncExternalStore(devicePrefs.subscribe, devicePrefs.get);
}

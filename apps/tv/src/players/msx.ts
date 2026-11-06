// Media Station X's native player through the Cineko MSX bridge plugin
// (/msx/bridge.html, same origin). The bridge writes a heartbeat to
// localStorage; play requests go over a BroadcastChannel (or, on engines
// without it, a localStorage key whose `storage` event the bridge watches).
import { storage } from "../platform";

export const BRIDGE_KEY = "martytv.msx_bridge";
export const CMD_KEY = "martytv.msx_cmd";
export const ACK_KEY = "martytv.msx_ack";
export const CHANNEL = "martytv-msx";
/** The bridge refreshes its heartbeat every 5 s; allow a few misses. */
export const ALIVE_MS = 15_000;
export const ACK_TIMEOUT = 3_500;

/** Heartbeat time from the stored JSON `{alive_at}`, or null. */
export function heartbeat(raw: string | null | undefined): number | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { alive_at?: unknown };
    return typeof v.alive_at === "number" && isFinite(v.alive_at) ? v.alive_at : null;
  } catch {
    return null;
  }
}

export function isAlive(raw: string | null | undefined, now: number): boolean {
  const at = heartbeat(raw);
  return at !== null && now - at <= ALIVE_MS && at - now <= ALIVE_MS;
}

/** Whether the bridge is running (MSX is hosting this TV app). */
export function bridgeAvailable(now = Date.now()): boolean {
  return isAlive(storage.get(BRIDGE_KEY), now);
}

/**
 * Whether the live bridge can launch external Android apps: MSX on
 * Android / Fire TV ≥ 0.1.136 (system:tvx:launch, checked by the bridge).
 */
export function launchSupported(raw: string | null | undefined, now: number): boolean {
  if (!isAlive(raw, now)) return false;
  try {
    return (JSON.parse(raw!) as { launch?: unknown }).launch === true;
  } catch {
    return false;
  }
}

export function bridgeCanLaunch(now = Date.now()): boolean {
  return launchSupported(storage.get(BRIDGE_KEY), now);
}

export interface MsxPlay {
  url: string;
  title: string;
  position_seconds: number;
}

export interface MsxAck {
  ok: boolean;
  error?: string;
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Parses an ack message (from the channel or the ack key) for `id`. */
export function matchAck(data: unknown, id: string): MsxAck | null {
  let v = data;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (typeof v !== "object" || v === null) return null;
  const m = v as { type?: unknown; id?: unknown; ok?: unknown; error?: unknown };
  if (m.type !== "ack" || m.id !== id) return null;
  return { ok: m.ok === true, ...(typeof m.error === "string" ? { error: m.error } : {}) };
}

/** Asks the bridge to play; resolves with its ack (or a timeout failure). */
export function playOnMsx(req: MsxPlay, timeout = ACK_TIMEOUT): Promise<MsxAck> {
  return send({ type: "play", url: req.url, title: req.title, position_seconds: req.position_seconds }, timeout);
}

export interface MsxLaunch extends MsxPlay {
  /** vlc / mx / system (Android's chooser). */
  app: string;
}

/**
 * Asks the bridge to open the stream in an external Android app
 * (system:tvx:launch). `onResult` gets MSX's app:result code later:
 * -2 / -3 = the app couldn't be launched.
 */
export function launchOnMsx(req: MsxLaunch, onResult?: (code: number | null) => void, timeout = ACK_TIMEOUT): Promise<MsxAck> {
  return send({ type: "launch", url: req.url, title: req.title, position_seconds: req.position_seconds, app: req.app }, timeout, onResult);
}

/** Parses an app:result message relayed by the bridge for `id`. */
export function matchResult(data: unknown, id: string): { code: number | null } | null {
  let v = data;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (typeof v !== "object" || v === null) return null;
  const m = v as { type?: unknown; id?: unknown; code?: unknown };
  if (m.type !== "result" || m.id !== id) return null;
  return { code: typeof m.code === "number" ? m.code : null };
}

/** How long to keep listening for a launch result (the app may run for hours). */
const RESULT_WAIT = 6 * 3600_000;

function send(body: Record<string, unknown>, timeout: number, onResult?: (code: number | null) => void): Promise<MsxAck> {
  const id = randomId();
  const msg = { ...body, id };
  const BC = (window as unknown as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  return new Promise((resolve) => {
    let ch: BroadcastChannel | null = null;
    let acked = false;
    let resultTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(resultTimer);
      window.removeEventListener("storage", onStorage);
      try {
        ch?.close();
      } catch {
        // ignore
      }
    };
    const finish = (ack: MsxAck) => {
      if (acked) return;
      acked = true;
      clearTimeout(timer);
      // A launch keeps listening for MSX's app:result (failure to launch).
      if (ack.ok && onResult) resultTimer = setTimeout(cleanup, RESULT_WAIT);
      else cleanup();
      resolve(ack);
    };
    const onMessage = (data: unknown) => {
      const ack = matchAck(data, id);
      if (ack) return finish(ack);
      const res = onResult ? matchResult(data, id) : null;
      if (res) {
        cleanup();
        onResult!(res.code);
      }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === ACK_KEY) onMessage(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), timeout);
    if (BC) {
      ch = new BC(CHANNEL);
      ch.onmessage = (e) => onMessage(e.data);
      ch.postMessage(msg);
    } else {
      storage.set(CMD_KEY, JSON.stringify(msg));
    }
  });
}

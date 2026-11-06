// The background speed test wired to the browser (TV app and PWA): the
// scheduler from ./speedtest plus window/document/navigator.connection
// events, the per-device setting and its persisted state. Touches the DOM
// only inside start(), so importing it is safe under node.
import {
  createScheduler,
  isCellular,
  measureThroughput,
  networkSignature,
  type ConnectionLike,
  type MeasureOptions,
  type Scheduler,
  type SchedulerEnv,
  type SchedulerState,
  type SkipReason,
} from "./speedtest";

/** «Измерять скорость интернета в фоне» (this device; on by default). */
export const SPEEDTEST_PREF_KEY = "martytv.speedtest_bg";
export const SPEEDTEST_STATE_KEY = "martytv.speedtest_state";

export interface AgentKV {
  get(k: string): string | null;
  set(k: string, v: string): void;
}

export interface AgentOptions {
  kv: AgentKV;
  fetchBytes: MeasureOptions["fetchBytes"];
  /** Video plays / the player or a stream being prepared is open. */
  busy: () => boolean;
  /** A finished measurement: store the sample and re-report the profile. */
  onResult: (bps: number) => void;
  now?: () => number;
}

export interface SpeedtestAgent {
  start(): void;
  stop(): void;
  /** Call on every player state change (true aborts a running test). */
  setBusy(busy: boolean): void;
  runNow(): Promise<{ bps: number | null; reason?: SkipReason | "failed" }>;
  running(): boolean;
  enabled(): boolean;
  setEnabled(on: boolean): void;
  /** Why background tests are paused by the connection (where detectable). */
  paused(): "cellular" | "save_data" | null;
  subscribe(l: () => void): () => void;
  /** Bumps on every change (useSyncExternalStore snapshot). */
  version(): number;
}

function connection(): (ConnectionLike & EventTarget) | null {
  try {
    const c = (typeof navigator !== "undefined" ? (navigator as Navigator & { connection?: ConnectionLike & EventTarget }).connection : undefined) ?? null;
    return c ?? null;
  } catch {
    return null;
  }
}

export function readSchedulerState(kv: AgentKV): SchedulerState {
  try {
    const v = JSON.parse(kv.get(SPEEDTEST_STATE_KEY) ?? "null") as { lastRunAt?: unknown; netSig?: unknown } | null;
    return {
      lastRunAt: v && typeof v.lastRunAt === "number" ? v.lastRunAt : null,
      netSig: v && typeof v.netSig === "string" ? v.netSig : null,
    };
  } catch {
    return { lastRunAt: null, netSig: null };
  }
}

export function createSpeedtestAgent(o: AgentOptions): SpeedtestAgent {
  const now = o.now ?? Date.now;
  const listeners = new Set<() => void>();
  let ver = 0;
  const emit = () => {
    ver++;
    listeners.forEach((l) => l());
  };
  const enabled = () => o.kv.get(SPEEDTEST_PREF_KEY) !== "0";
  const env = (): SchedulerEnv => {
    const c = connection();
    return {
      enabled: enabled(),
      busy: o.busy(),
      hidden: typeof document !== "undefined" && document.visibilityState === "hidden",
      online: typeof navigator === "undefined" || navigator.onLine !== false,
      saveData: !!c?.saveData,
      cellular: isCellular(c),
    };
  };
  const sched: Scheduler = createScheduler({
    now,
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    env,
    netSig: () => networkSignature(connection()),
    load: () => readSchedulerState(o.kv),
    save: (s) => o.kv.set(SPEEDTEST_STATE_KEY, JSON.stringify(s)),
    measure: (signal) => measureThroughput({ fetchBytes: o.fetchBytes, signal, now }),
    onResult: (bps) => o.onResult(bps),
    onChange: emit,
  });

  let hiddenAt: number | null = null;
  const onOnline = () => sched.networkChanged();
  const onConn = () => sched.networkChanged();
  const onVis = () => {
    if (document.visibilityState === "hidden") hiddenAt = now();
    else if (hiddenAt != null) {
      const ms = now() - hiddenAt;
      hiddenAt = null;
      sched.visible(ms);
    }
  };
  let started = false;

  return {
    start() {
      // Very old TV engines (no AbortController): no background tests.
      if (started || typeof window === "undefined" || typeof AbortController === "undefined") return;
      started = true;
      try {
        window.addEventListener("online", onOnline);
        document.addEventListener("visibilitychange", onVis);
        connection()?.addEventListener?.("change", onConn);
      } catch {
        // old engines: the timers still work
      }
      sched.setBusy(o.busy());
      sched.start();
    },
    stop() {
      if (!started) return;
      started = false;
      sched.stop();
      try {
        window.removeEventListener("online", onOnline);
        document.removeEventListener("visibilitychange", onVis);
        connection()?.removeEventListener?.("change", onConn);
      } catch {
        // ignore
      }
    },
    setBusy: (b) => sched.setBusy(b),
    runNow: () => (typeof AbortController === "undefined" ? Promise.resolve({ bps: null, reason: "failed" as const }) : sched.runNow()),
    running: () => sched.running(),
    enabled,
    setEnabled(on) {
      o.kv.set(SPEEDTEST_PREF_KEY, on ? "1" : "0");
      emit();
    },
    paused() {
      const c = connection();
      if (isCellular(c)) return "cellular";
      if (c?.saveData) return "save_data";
      return null;
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    version: () => ver,
  };
}

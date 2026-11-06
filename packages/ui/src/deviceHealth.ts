// TV health («Состояние»): formatting and «looks bad» checks for the values a
// TV reports about its own load (DeviceHealthSample in openapi.yaml). Shared
// by the web Devices page / Admin → Devices and the TV's «Об этом
// телевизоре». Pure: no DOM, no network.
import type { MessageKey } from "./i18n";

/** The measurement fields of DeviceHealthSample (all optional). */
export interface HealthValues {
  heap_used_mb?: number | null;
  heap_total_mb?: number | null;
  heap_limit_mb?: number | null;
  device_memory_gb?: number | null;
  cores?: number | null;
  fps?: number | null;
  slow_frames_pct?: number | null;
  lag_ms?: number | null;
  lag_max_ms?: number | null;
  long_tasks?: number | null;
  long_task_ms?: number | null;
  dropped_frames?: number | null;
  total_frames?: number | null;
}

/** Where values start to look bad. */
export const HEALTH_LIMITS = {
  /** Median frame rate below this. */
  fps: 30,
  /** Median event-loop delay above this (ms). */
  lagMs: 100,
  /** JS heap above this share of its limit. */
  heapShare: 0.85,
  /** Dropped video frames above this share (%). */
  droppedPct: 5,
} as const;

/** A TV that reports every 10 min and has been silent this long is «не отправляет». */
export const HEALTH_STALE_MS = 30 * 60_000;

export type HealthPartId = "heap" | "ram" | "cores" | "fps" | "lag" | "dropped" | "long_tasks";

export interface HealthPart {
  id: HealthPartId;
  text: string;
  bad: boolean;
}

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

const num = (v: number | null | undefined): v is number => typeof v === "number" && isFinite(v);

/** «0,4» in ru, «0.4» in en; integers above 10. */
export function fmtNum(v: number, locale: string, digits = 1): string {
  const d = Math.abs(v) >= 10 ? 0 : digits;
  const s = (Math.round(v * 10 ** d) / 10 ** d).toFixed(d).replace(/\.0+$/, "");
  return locale === "ru" ? s.replace(".", ",") : s;
}

/** Russian-style plural form (en: one / many). */
export function pluralForm(locale: string, n: number): "one" | "few" | "many" {
  const a = Math.abs(Math.round(n));
  if (locale !== "ru") return a === 1 ? "one" : "many";
  const m10 = a % 10;
  const m100 = a % 100;
  if (m10 === 1 && m100 !== 11) return "one";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "few";
  return "many";
}

/** Dropped share of decoded video frames (%), or null when unknown / no frames. */
export function droppedPct(v: HealthValues): number | null {
  if (!num(v.dropped_frames) || !num(v.total_frames) || v.total_frames <= 0) return null;
  return (v.dropped_frames / v.total_frames) * 100;
}

/** Which values look bad. */
export function healthFlags(v: HealthValues): { slow: boolean; memory: boolean } & Record<"fps" | "lag" | "heap" | "dropped", boolean> {
  const fps = num(v.fps) && v.fps < HEALTH_LIMITS.fps;
  const lag = num(v.lag_ms) && v.lag_ms > HEALTH_LIMITS.lagMs;
  const heap = num(v.heap_used_mb) && num(v.heap_limit_mb) && v.heap_limit_mb > 0 && v.heap_used_mb / v.heap_limit_mb > HEALTH_LIMITS.heapShare;
  const d = droppedPct(v);
  const dropped = d !== null && d > HEALTH_LIMITS.droppedPct;
  return { fps, lag, heap, dropped, slow: fps || lag || dropped, memory: heap };
}

/**
 * The compact line's parts: «Память приложения 182 / 1024 МБ · ОЗУ ~2 ГБ ·
 * 4 ядра · 58 к/с · задержка 12 мс · пропущено кадров 0,4 %». Unknown values
 * are left out.
 */
export function healthParts(v: HealthValues, t: T, locale: string, opts: { longTasks?: boolean } = {}): HealthPart[] {
  const f = healthFlags(v);
  const out: HealthPart[] = [];
  if (num(v.heap_used_mb)) {
    const used = Math.round(v.heap_used_mb);
    out.push({
      id: "heap",
      text: num(v.heap_limit_mb) && v.heap_limit_mb > 0 ? t("health.heap", { used, limit: Math.round(v.heap_limit_mb) }) : t("health.heap_used", { used }),
      bad: f.heap,
    });
  }
  if (num(v.device_memory_gb) && v.device_memory_gb > 0) out.push({ id: "ram", text: t("health.ram", { gb: fmtNum(v.device_memory_gb, locale) }), bad: false });
  if (num(v.cores) && v.cores > 0) out.push({ id: "cores", text: t(`health.cores_${pluralForm(locale, v.cores)}`, { n: v.cores }), bad: false });
  if (num(v.fps)) out.push({ id: "fps", text: t("health.fps", { fps: Math.round(v.fps) }), bad: f.fps });
  if (num(v.lag_ms)) out.push({ id: "lag", text: t("health.lag", { ms: Math.round(v.lag_ms) }), bad: f.lag });
  const d = droppedPct(v);
  if (d !== null) out.push({ id: "dropped", text: t("health.dropped", { pct: fmtNum(d, locale) }), bad: f.dropped });
  if (opts.longTasks && num(v.long_tasks)) {
    out.push({ id: "long_tasks", text: t("health.long_tasks", { n: v.long_tasks, ms: Math.round(v.long_task_ms ?? 0) }), bad: false });
  }
  return out;
}

/** Hints for what looks bad (slow first). */
export function healthHints(v: HealthValues): MessageKey[] {
  const f = healthFlags(v);
  const out: MessageKey[] = [];
  if (f.slow) out.push("health.hint_slow");
  if (f.memory) out.push("health.hint_memory");
  return out;
}

/** No report, or the newest is older than HEALTH_STALE_MS. */
export function healthStale(at: string | null | undefined, now: number): boolean {
  if (!at) return true;
  const ms = Date.parse(at);
  return !isFinite(ms) || now - ms > HEALTH_STALE_MS;
}

/** A value over the history (given newest first), oldest → newest, known values only. */
export function healthSeries<K extends keyof HealthValues>(history: HealthValues[], key: K): number[] {
  const out: number[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const v = history[i]![key];
    if (num(v)) out.push(v);
  }
  return out;
}

/** SVG polyline points for a tiny sparkline (w×h box), or "" for < 2 values. */
export function sparkPoints(values: number[], w: number, h: number): string {
  if (values.length < 2) return "";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  return values
    .map((v, i) => `${Math.round((i / (values.length - 1)) * w * 10) / 10},${Math.round((h - ((v - lo) / span) * h) * 10) / 10}`)
    .join(" ");
}

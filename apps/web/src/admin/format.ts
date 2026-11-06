// Formatting and threshold helpers for the admin Server tab (pure, tested).
import type { Locale } from "@martytv/ui";

const BYTE_UNITS: Record<Locale, string[]> = {
  en: ["B", "KB", "MB", "GB", "TB"],
  ru: ["Б", "КБ", "МБ", "ГБ", "ТБ"],
};
const BIT_UNITS: Record<Locale, string[]> = {
  en: ["bit/s", "kbit/s", "Mbit/s", "Gbit/s"],
  ru: ["бит/с", "кбит/с", "Мбит/с", "Гбит/с"],
};

/** One decimal below 10, none above: 4.2, 42, 420. */
function num(v: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: Math.abs(v) >= 10 ? 0 : 1 }).format(v);
}

function scaled(v: number, base: number, units: string[], locale: Locale): string {
  if (!Number.isFinite(v) || v < 0) return "—";
  let i = 0;
  while (v >= base && i < units.length - 1) {
    v /= base;
    i++;
  }
  return `${num(v, locale)} ${units[i]}`;
}

/** Binary sizes: 1536 → "1.5 KB" (ru: "1,5 КБ"). */
export function formatBytes(bytes: number | null | undefined, locale: Locale = "en"): string {
  if (bytes == null) return "—";
  return scaled(bytes, 1024, BYTE_UNITS[locale], locale);
}

/** Network rates arrive in bytes/s and are shown in bits/s (decimal), like ISPs do. */
export function formatRate(bytesPerSecond: number | null | undefined, locale: Locale = "en"): string {
  if (bytesPerSecond == null) return "—";
  return scaled(bytesPerSecond * 8, 1000, BIT_UNITS[locale], locale);
}

/** 42.3 → "42%", 4.27 → "4.3%", 0 → "0%". */
export function formatPercent(v: number | null | undefined, locale: Locale = "en"): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const digits = v !== 0 && Math.abs(v) < 10 ? 1 : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(v)}%`;
}

/** 0..100 share, safe for a zero total. */
export function percentOf(part: number, total: number): number {
  return total > 0 ? Math.min(100, Math.max(0, (part / total) * 100)) : 0;
}

/** 93784 s → "1d 2h" / "1 д 2 ч"; under an hour → "12m". */
export function formatUptime(seconds: number, locale: Locale = "en"): string {
  const [d, h, m] = locale === "ru" ? ["д", "ч", "мин"] : ["d", "h", "m"];
  const sp = locale === "ru" ? " " : "";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}${sp}${d} ${hours}${sp}${h}`;
  if (hours > 0) return `${hours}${sp}${h} ${mins}${sp}${m}`;
  return `${mins}${sp}${m}`;
}

export function formatLoad(v: number, locale: Locale = "en"): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}

export type Level = "ok" | "warn" | "crit";

/** Thresholds for warning colours (percent or ratio as noted). */
export const THRESHOLDS = {
  cpu: [85, 95], // % busy
  ram: [85, 95], // % of RAM used
  swap: [50, 80], // % of swap used (swapping hurts streaming)
  disk: [90, 95], // % of disk used
  load: [1, 2], // load1 ÷ cores
} as const;

export function level(value: number, [warn, crit]: readonly [number, number]): Level {
  if (!Number.isFinite(value)) return "ok";
  if (value >= crit) return "crit";
  if (value > warn) return "warn";
  return "ok";
}

export const cpuLevel = (pct: number) => level(pct, THRESHOLDS.cpu);
export const ramLevel = (used: number, total: number) => level(percentOf(used, total), THRESHOLDS.ram);
export const swapLevel = (used: number, total: number) => (total > 0 ? level(percentOf(used, total), THRESHOLDS.swap) : "ok");
export const diskLevel = (used: number, total: number) => level(percentOf(used, total), THRESHOLDS.disk);
/** Load above the core count means work is queueing. */
export const loadLevel = (load1: number, cores: number) => (cores > 0 ? level(load1 / cores, THRESHOLDS.load) : "ok");

/** Worst of several levels. */
export function worst(...levels: Level[]): Level {
  return levels.includes("crit") ? "crit" : levels.includes("warn") ? "warn" : "ok";
}

/** A "nice" upper bound for a chart axis: 0.7 → 1, 3.2 → 4, 730 → 1000. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 4, 5, 10]) if (m * pow >= v) return m * pow;
  return 10 * pow;
}

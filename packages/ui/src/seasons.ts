// Seasonal / holiday calendar (pure: no DOM, no React). Dates are civil
// dates in Moscow by default (the household's time zone); every window is
// inclusive. Movable feasts follow the Orthodox (Julian) computus.
//
// Each season has MAIN days (the holiday itself: full effects, the greeting)
// and a window around them: LEAD days before (effects ramp up, a softer
// «Скоро …» note) and TAIL days after. All of it lives in one table,
// SEASON_TABLE below — change the numbers there.
//
// | id           | holiday                  | main days                       | window (lead / tail)              |
// |--------------|--------------------------|---------------------------------|-----------------------------------|
// | newyear      | Новый год                | Dec 31 – Jan 1                  | Dec 24 – Jan 8 (7 / 7)            |
// | christmas    | Рождество (Orthodox)     | Jan 6 – 7                       | Jan 6 – 7 (inside New Year)       |
// | oldnewyear   | Старый Новый год         | Jan 13 – 14                     | Jan 9 – 14 (4 / 0): snow to Jan 14|
// | valentine    | День святого Валентина   | Feb 14                          | Feb 10 – 14 (4 / 0)               |
// | defender     | День защитника Отечества | Feb 23                          | Feb 19 – 23 (4 / 0)               |
// | maslenitsa   | Масленица                | Mon – Forgiveness Sunday (Easter − 49) | 4 days before the week (4 / 0) |
// | women        | 8 Марта                  | Mar 8                           | Mar 4 – 8 (4 / 0)                 |
// | cosmonautics | День космонавтики        | Apr 12                          | Apr 8 – 12 (4 / 0)                |
// | easter       | Пасха (Orthodox)         | Easter Sunday + Bright Monday   | Easter − 3 … Monday (3 / 0)       |
// | victory      | День Победы              | May 9                           | May 5 – 9 (4 / 0)                 |
// | russia       | День России              | Jun 12                          | Jun 8 – 12 (4 / 0)                |
// | knowledge    | 1 сентября (День знаний) | Sep 1                           | Aug 28 – Sep 1 (4 / 0)            |
// | halloween    | Хэллоуин                 | Oct 31                          | Oct 27 – Nov 1 (4 / 1)            |
//
// Overlaps: a season on its MAIN days beats any lead/tail days (Масленица's
// week over 23 Февраля's lead-up; 23 Февраля itself over Масленица); among
// equals PRIORITY decides (День Победы over a late Easter, Christmas over
// New Year, Easter over Cosmonautics Day — both Apr 12 in 2026). No autumn
// fallback: outside the windows there is no season.

export type SeasonId =
  | "newyear"
  | "christmas"
  | "oldnewyear"
  | "valentine"
  | "defender"
  | "maslenitsa"
  | "women"
  | "cosmonautics"
  | "easter"
  | "victory"
  | "russia"
  | "knowledge"
  | "halloween";

/** Every season in calendar order (pickers, previews). */
export const SEASONS: SeasonId[] = [
  "newyear",
  "christmas",
  "oldnewyear",
  "valentine",
  "defender",
  "maslenitsa",
  "women",
  "cosmonautics",
  "easter",
  "victory",
  "russia",
  "knowledge",
  "halloween",
];

/** Overlap resolution: the first season whose window contains the date wins. */
export const PRIORITY: SeasonId[] = [
  "victory",
  "christmas",
  "newyear",
  "oldnewyear",
  "women",
  "defender",
  "easter",
  "maslenitsa",
  "valentine",
  "cosmonautics",
  "russia",
  "knowledge",
  "halloween",
];

export function isSeasonId(v: unknown): v is SeasonId {
  return typeof v === "string" && (SEASONS as string[]).includes(v);
}

/** A civil date. */
export interface Ymd {
  y: number;
  m: number; // 1–12
  d: number;
}

/** An inclusive window of civil dates. */
export interface SeasonWindow {
  id: SeasonId;
  start: Ymd;
  end: Ymd;
}

const DAY = 86_400_000;
const toDays = (v: Ymd) => Date.UTC(v.y, v.m - 1, v.d) / DAY;
const fromDays = (n: number): Ymd => {
  const t = new Date(n * DAY);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const addDays = (v: Ymd, n: number) => fromDays(toDays(v) + n);
const ymd = (y: number, m: number, d: number): Ymd => ({ y, m, d });

/** "YYYY-MM-DD". */
export function ymdString(v: Ymd): string {
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${v.y}-${p(v.m)}-${p(v.d)}`;
}

/**
 * Orthodox Easter Sunday as a Gregorian date: the Julian computus (Meeus),
 * then the Julian → Gregorian offset of that century (13 days in 1900–2099).
 */
export function orthodoxEaster(year: number): Ymd {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31); // 3 = March, 4 = April (Julian)
  const day = ((d + e + 114) % 31) + 1;
  const offset = Math.floor(year / 100) - Math.floor(year / 400) - 2;
  return addDays(ymd(year, month, day), offset);
}

/** Масленица: Monday – Forgiveness Sunday (Прощёное воскресенье = Easter − 49 days). */
export function maslenitsaWindow(year: number): { start: Ymd; end: Ymd } {
  const sunday = addDays(orthodoxEaster(year), -49);
  return { start: addDays(sunday, -6), end: sunday };
}

/** One row of the calendar: the main days of the holiday in `year`, plus lead/tail days around them. */
interface SeasonRule {
  id: SeasonId;
  main: (year: number) => { start: Ymd; end: Ymd };
  lead: number;
  tail: number;
}

const day = (m: number, d: number, m2 = m, d2 = d) => (year: number) => ({ start: ymd(year, m, d), end: ymd(year, m2, d2) });

/** The calendar (see the table at the top). */
export const SEASON_TABLE: SeasonRule[] = [
  { id: "newyear", main: (y) => ({ start: ymd(y, 12, 31), end: ymd(y + 1, 1, 1) }), lead: 7, tail: 7 },
  { id: "christmas", main: day(1, 6, 1, 7), lead: 0, tail: 0 },
  { id: "oldnewyear", main: day(1, 13, 1, 14), lead: 4, tail: 0 },
  { id: "valentine", main: day(2, 14), lead: 4, tail: 0 },
  { id: "defender", main: day(2, 23), lead: 4, tail: 0 },
  { id: "maslenitsa", main: (y) => maslenitsaWindow(y), lead: 4, tail: 0 },
  { id: "women", main: day(3, 8), lead: 4, tail: 0 },
  { id: "cosmonautics", main: day(4, 12), lead: 4, tail: 0 },
  { id: "easter", main: (y) => ({ start: orthodoxEaster(y), end: addDays(orthodoxEaster(y), 1) }), lead: 3, tail: 0 },
  { id: "victory", main: day(5, 9), lead: 4, tail: 0 },
  { id: "russia", main: day(6, 12), lead: 4, tail: 0 },
  { id: "knowledge", main: day(9, 1), lead: 4, tail: 0 },
  { id: "halloween", main: day(10, 31), lead: 4, tail: 1 },
];

/** A season's window (`start`–`end`) and its main days, for the window that belongs to `year`. */
export interface SeasonSpan extends SeasonWindow {
  mainStart: Ymd;
  mainEnd: Ymd;
  year: number;
}

/**
 * Every season's window for `year` (New Year's runs Dec 24 of `year` to
 * Jan 8 of the next one).
 */
export function seasonWindows(year: number): SeasonSpan[] {
  return SEASON_TABLE.map((r) => {
    const m = r.main(year);
    return { id: r.id, start: addDays(m.start, -r.lead), end: addDays(m.end, r.tail), mainStart: m.start, mainEnd: m.end, year };
  });
}

/** The window of one season that belongs to `year`. */
export function seasonWindow(id: SeasonId, year: number): SeasonSpan {
  return seasonWindows(year).find((w) => w.id === id)!;
}

/**
 * The civil date of `date` in `tz`. Moscow has been UTC+3 all year since
 * October 2014, so it needs no time-zone data (old TV engines may lack
 * it); other zones go through Intl, falling back to the device's own.
 */
export function civilDate(date: Date, tz = "Europe/Moscow"): Ymd {
  if (tz === "Europe/Moscow") {
    const t = new Date(date.getTime() + 3 * 3_600_000);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(date);
    const get = (k: string) => Number(parts.find((p) => p.type === k)?.value);
    const out = { y: get("year"), m: get("month"), d: get("day") };
    if (out.y && out.m && out.d) return out;
  } catch {
    // unknown zone / no Intl time zones: the device's local date
  }
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
}

/** Where a date sits in a season. */
export interface SeasonState {
  id: SeasonId;
  /** On the holiday's main days. */
  main: boolean;
  /** Days until the main days start (0 on and after them). */
  daysToMain: number;
  /** 0.45 … 1: particle intensity, ramping up through the lead days (1 on and after the main days). */
  intensity: number;
  /** The window's year (greeting keys: New Year's January belongs to December's window). */
  year: number;
}

/** Ramp-up: −15% per day before the main days, never below 45%. */
export function rampIntensity(daysToMain: number): number {
  return daysToMain <= 0 ? 1 : Math.max(0.45, Math.round((1 - 0.15 * daysToMain) * 100) / 100);
}

/** The season on `date` (civil date in `tz`) with its phase, or null. */
export function seasonState(date: Date, tz = "Europe/Moscow"): SeasonState | null {
  const today = civilDate(date, tz);
  const n = toDays(today);
  // This year's windows plus last year's New Year (which runs into January).
  const spans = [...seasonWindows(today.y), seasonWindow("newyear", today.y - 1)].filter((w) => toDays(w.start) <= n && n <= toDays(w.end));
  if (spans.length === 0) return null;
  const isMain = (w: SeasonSpan) => toDays(w.mainStart) <= n && n <= toDays(w.mainEnd);
  const rank = (w: SeasonSpan) => (isMain(w) ? 0 : 100) + PRIORITY.indexOf(w.id);
  const w = spans.sort((a, b) => rank(a) - rank(b))[0]!;
  const daysToMain = Math.max(0, toDays(w.mainStart) - n);
  return { id: w.id, main: isMain(w), daysToMain, intensity: rampIntensity(daysToMain), year: w.year };
}

/** The season on `date` (civil date in `tz`), or null. */
export function activeSeason(date: Date, tz = "Europe/Moscow"): SeasonId | null {
  return seasonState(date, tz)?.id ?? null;
}

// ---------------------------------------------------------------- render decision

/** ProfileSettings.seasonal_effects. */
export type SeasonalSetting = "on" | "calm" | "off";
export const SEASONAL_SETTINGS: SeasonalSetting[] = ["on", "calm", "off"];

/** How the season layer draws: animated, still decorations, or nothing. */
export type SeasonRender = "full" | "static" | "none";

/** Seasons that never animate (День Победы: a ribbon and a badge only). */
export const STATIC_SEASONS: SeasonId[] = ["victory"];

export interface SeasonInputs {
  season: SeasonId | null;
  /** The profile's seasonal_effects. */
  setting: SeasonalSetting;
  /** The admin's global switch (GET /status seasonal_effects). */
  adminEnabled: boolean;
  /** prefers-reduced-motion. */
  reducedMotion?: boolean;
  /** The TV's calm-motion preference (martytv.calm_motion). */
  calmMotion?: boolean;
  /** A video is playing. */
  playing?: boolean;
  /** A screen where decorations distract (Details, title page, overlays). */
  suppressed?: boolean;
  /** An explicit preview from Settings: shown even when the setting is off. */
  preview?: boolean;
}

/**
 * Whether and how to draw the season. Nothing during playback or on
 * distracting screens; an explicit preview ignores the profile's "off"
 * (but not playback); otherwise the admin switch and "off" hide it; calm
 * (setting, reduced motion or the TV's calm motion) and День Победы are
 * still.
 */
export function seasonRender(i: SeasonInputs): SeasonRender {
  if (!i.season || i.playing || i.suppressed) return "none";
  if (!i.preview && (!i.adminEnabled || i.setting === "off")) return "none";
  if (STATIC_SEASONS.includes(i.season)) return "static";
  if (i.setting === "calm" || i.reducedMotion || i.calmMotion) return "static";
  return "full";
}

/** `?season=<id>` from a query string (QA override): a season, "off" (force none), or null (no/unknown value). */
export function seasonParam(search: string): SeasonId | "off" | null {
  const m = /[?&]season=([a-z]+)/.exec(search);
  if (!m) return null;
  if (m[1] === "off" || m[1] === "none") return "off";
  return isSeasonId(m[1]) ? m[1] : null;
}

/**
 * localStorage key of a once-per-season greeting: `day` on the holiday's
 * main days, `soon` (the softer «Скоро …») during the lead-up; one each
 * per season window.
 */
export function greetingKey(st: Pick<SeasonState, "id" | "year">, phase: "soon" | "day"): string {
  return `martytv.season_greeted.${st.id}.${st.year}.${phase}`;
}

/** A season forced by `?season=` or a preview: shown as on its main day. */
export function forcedState(id: SeasonId, date: Date): SeasonState {
  return { id, main: true, daysToMain: 0, intensity: 1, year: civilDate(date).y };
}

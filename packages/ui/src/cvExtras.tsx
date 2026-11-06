// «Конструктивизм» jokes shared by TV and web (that design only): the
// five-year viewing plan and the week's «стахановец», the red news ticker,
// «Госкино» classics, renamed menu items, «ударник» ratings with the Soviet
// «Знак качества», the «очередь за дефицитом» and the error / offline lines.
// Pure helpers are unit-tested; the components are tiny and CSS-animated
// (transform only).
import type { CSSProperties } from "react";

// ---------------------------------------------------------------- the five-year plan

export interface HistLike {
  media: { id: string; title: string; kind: string };
  progress: { completed: boolean; completed_at: string | null };
}

/** Titles to finish per year («пятилетка» — in a year, naturally). */
export const PLAN_TARGET = 60;

function finishedBetween<T extends HistLike>(items: readonly T[], from: Date, to: Date): T[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    if (!it.progress.completed || !it.progress.completed_at || seen.has(it.media.id)) return false;
    const at = new Date(it.progress.completed_at).getTime();
    if (!(at >= from.getTime() && at < to.getTime())) return false;
    seen.add(it.media.id);
    return true;
  });
}

export interface Plan {
  year: number;
  done: number;
  target: number;
  /** 0..999 (over 100 when overfulfilled). */
  pct: number;
}

/** Titles the profile finished this calendar year against the plan. */
export function planOf(items: readonly HistLike[], now: Date = new Date(), target = PLAN_TARGET): Plan {
  const year = now.getFullYear();
  const done = finishedBetween(items, new Date(year, 0, 1), new Date(year + 1, 0, 1)).length;
  return { year, done, target, pct: Math.min(999, Math.round((done / target) * 100)) };
}

/** Monday 00:00 (local) of the week `now` is in. */
export function weekStart(now: Date = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return d;
}

/** The profile that finished the most titles this week (ties: the first listed); null when nobody finished anything. */
export function stakhanovets(list: readonly { name: string; items: readonly HistLike[] }[], now: Date = new Date()): { name: string; count: number } | null {
  const from = weekStart(now);
  const to = new Date(from.getTime() + 7 * 24 * 3600_000 + 3600_000); // +1 h: DST-safe
  let best: { name: string; count: number } | null = null;
  for (const p of list) {
    const count = finishedBetween(p.items, from, to).length;
    if (count > 0 && (!best || count > best.count)) best = { name: p.name, count };
  }
  return best;
}

/** Titles finished this year (ids + titles), for the «план перевыполнен» toast. */
export function finishedThisYear(items: readonly HistLike[], now: Date = new Date()): { id: string; title: string }[] {
  const y = now.getFullYear();
  return finishedBetween(items, new Date(y, 0, 1), new Date(y + 1, 0, 1)).map((it) => ({ id: it.media.id, title: it.media.title }));
}

/** Which of `now` weren't finished last time (null = first look: none, so the toast never fires on a fresh device). */
export function newlyFinished(prev: readonly string[] | null, now: readonly { id: string; title: string }[]): { id: string; title: string }[] {
  if (!prev) return [];
  const had = new Set(prev);
  return now.filter((x) => !had.has(x.id));
}

const seenKey = (profile: string, year: number) => `martytv.cv.plan.${profile}.${year}`;

/** Remembers what was finished; returns the titles finished since the last call (once per finish). */
export function takeNewlyFinished(profile: string, now: { id: string; title: string }[], year: number, store: Pick<Storage, "getItem" | "setItem"> | null = safeLocal()): { id: string; title: string }[] {
  let prev: string[] | null;
  try {
    const raw = store?.getItem(seenKey(profile, year));
    prev = raw ? (JSON.parse(raw) as string[]) : null;
  } catch {
    prev = null;
  }
  const fresh = newlyFinished(prev, now);
  try {
    store?.setItem(seenKey(profile, year), JSON.stringify(now.map((x) => x.id)));
  } catch {
    /* ignore */
  }
  return fresh;
}

function safeLocal(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** Russian plural of «фильм» for counts. */
export function filmsRu(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "фильм";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "фильма";
  return "фильмов";
}

// ---------------------------------------------------------------- news ticker

/** Funny fake headlines for Home's red strip. */
export const CV_NEWS: readonly string[] = [
  "Колхоз «Попкорн» собрал рекордный урожай",
  "Сеанс начнётся строго по расписанию",
  "Буферизация побеждена досрочно",
  "Семья Ивановых досмотрела сериал за одну пятилетку",
  "Пульт найден под диваном: следствие закрыто",
  "Трудящиеся требуют добавки субтитров",
  "Торренты перевыполнили план по раздаче",
  "Диван признан передовиком производства",
  "Чайник вскипел к началу второй серии",
  "Объявлен месячник семейного просмотра",
  "Титры досмотрены до конца: подвиг зрителя",
  "4K доставлен в каждый дом",
];

/**
 * A slow marquee: the line repeated twice and slid by half its width
 * (transform only, linear, infinite). `paused` stops it (tab hidden,
 * playback over it).
 */
export function NewsTicker({ items = CV_NEWS, paused = false, seconds = 90, className = "", style }: { items?: readonly string[]; paused?: boolean; seconds?: number; className?: string; style?: CSSProperties }) {
  const line = items.map((s) => `★ ${s}`).join("   ");
  return (
    <div data-testid="cv-news" data-paused={paused ? "1" : "0"} aria-hidden className={`cv-news overflow-hidden whitespace-nowrap ${className}`} style={style}>
      <style>{NEWS_CSS}</style>
      <div className="cv-news-track" style={{ animationDuration: `${seconds}s`, animationPlayState: paused ? "paused" : "running" }}>
        <span>{line}&nbsp;&nbsp;&nbsp;</span>
        <span>{line}&nbsp;&nbsp;&nbsp;</span>
      </div>
    </div>
  );
}

const NEWS_CSS = `
@keyframes cvNews{from{transform:translate3d(0,0,0)}to{transform:translate3d(-50%,0,0)}}
.cv-news-track{display:inline-block;white-space:nowrap;animation-name:cvNews;animation-timing-function:linear;animation-iteration-count:infinite;will-change:transform}
@media (prefers-reduced-motion: reduce){.cv-news-track{animation:none}}
`;

// ---------------------------------------------------------------- «Госкино» classics

/** The curated list behind «Рекомендовано Госкино» (GET /curated/{id}; internal/curated/lists). */
export const GOSKINO_LIST_ID = "soviet-goskino";

// ---------------------------------------------------------------- menu labels

/** Menu items renamed in this design (visible text only; ids, test ids and aria labels stay). */
export const CV_MENU: Record<string, string> = {
  home: "Главк",
  history: "Архив",
  search: "Розыск",
  mine: "Дефицит",
  favorites: "Дефицит",
  lists: "Дефицит",
  settings: "Политбюро",
  ask: "Товарищ ЭВМ",
};

/** The menu label in this design (`fallback` otherwise / for other items). */
export function cvMenuLabel(cv: boolean, id: string, fallback: string): string {
  return (cv && CV_MENU[id]) || fallback;
}

// ---------------------------------------------------------------- ratings

/** «Знак качества» from this rating (KP or TMDB, 0–10). */
export const QUALITY_MARK_MIN = 8.5;
/** «ударник ★…» from this rating. */
export const UDARNIK_MIN = 8;

export function hasQualityMark(ratings: readonly (number | null | undefined)[]): boolean {
  return ratings.some((r) => typeof r === "number" && r >= QUALITY_MARK_MIN);
}

/** «ударник ★8.7» for a high rating, else null. */
export function udarnikLabel(rating: number | null | undefined, locale = "ru"): string | null {
  if (typeof rating !== "number" || rating < UDARNIK_MIN) return null;
  const v = rating.toFixed(1).replace(/\.0$/, "");
  return `ударник ★${locale === "ru" ? v.replace(".", ",") : v}`;
}

/**
 * The Soviet «Знак качества»: a pentagon shield with the stylised «К» /
 * «Q» glyph (a man-with-raised-arms figure). Inline SVG, red on cream.
 */
export function QualityMark({ size = 40, className = "", style }: { size?: number; className?: string; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 100 100" width={size || undefined} height={size || undefined} className={className} style={style} data-testid="cv-quality" aria-label="Знак качества" role="img" focusable="false">
      <polygon points="50,3 96,36 79,95 21,95 4,36" fill="#efe4cc" stroke="#d7261e" strokeWidth="6" strokeLinejoin="round" />
      {/* The glyph: a pentagon within, crossed by the «К» strokes. */}
      <polygon points="50,20 80,41 69,82 31,82 20,41" fill="none" stroke="#d7261e" strokeWidth="5" strokeLinejoin="round" />
      <path d="M42 34 V72 M42 54 L60 36 M47 50 L62 72" fill="none" stroke="#d7261e" strokeWidth="7" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

// ---------------------------------------------------------------- «очередь за дефицитом»

/** Popular enough to have a queue (TMDB votes / rating). */
export function isDeficit(m: { vote_count?: number | null; rating?: number | null }): boolean {
  return (m.vote_count ?? 0) >= 3000 && (m.rating ?? 0) >= 7;
}

/** Place in the queue: 2…5. */
export function queuePlace(rand: () => number = Math.random): number {
  const x = rand();
  const r = Number.isFinite(x) ? x : 0;
  return 2 + Math.min(3, Math.max(0, Math.floor(r * 4)));
}

const QUEUE_KEY = "martytv.cv.queue";

/** Shows the queue once per title per session: true the first time (and records it). */
export function takeQueueTurn(mediaId: string, store: Pick<Storage, "getItem" | "setItem"> | null = safeSession()): boolean {
  try {
    const seen = new Set<string>(JSON.parse(store?.getItem(QUEUE_KEY) ?? "[]") as string[]);
    if (seen.has(mediaId)) return false;
    seen.add(mediaId);
    store?.setItem(QUEUE_KEY, JSON.stringify([...seen].slice(-200)));
    return true;
  } catch {
    return false;
  }
}

function safeSession(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

/** How long the queue overlay stays (ms). */
export const QUEUE_MS = 1200;

export function queueText(n: number): string {
  return `Вы ${n}-й в очереди за дефицитом…`;
}

// ---------------------------------------------------------------- errors

export const CV_ERROR = "Товарищ, сервер на субботнике. Повторите попытку";
export const CV_OFFLINE = "Связь с Центром временно прервана";

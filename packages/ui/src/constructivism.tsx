// «Конструктивизм» extras shared by TV and web: the rotating poster slogans
// of its loading screens and the «Ленин в Октябре» recommendation (found by
// a catalog search at runtime, cached on the device).
import { useEffect, useState, type CSSProperties } from "react";
import { normTitle } from "./cvSearch";

// ---------------------------------------------------------------- slogans

/** Poster slogans about cinema, loading and family viewing (Russian on purpose — it is the joke). */
export const CV_SLOGANS: readonly string[] = [
  "Важнейшим из искусств для нас является кино!",
  "Кино — в массы!",
  "Пятилетку — за четыре сеанса!",
  "Попкорн — каждой семье!",
  "Буферизация — дело общее!",
  "Даёшь 4K!",
  "Сеанс начнётся по плану!",
  "Пролетарии всех стран, садитесь смотреть!",
  "Сиды и пиры — объединяйтесь!",
  "Вся семья — к экрану!",
  "Каждому дивану — по фильму!",
  "Пульт — в надёжные руки!",
  "Перевыполним план по сериям!",
  "Электрификацию — всему кинозалу!",
  "Субтитры — грамотному зрителю!",
  "Ни одного кадра мимо!",
  "Догоним и перегоним по битрейту!",
  "Свет — погасить, звук — прибавить!",
  "Чай заварен — фильм на подходе!",
];

/** How long a slogan stays (ms). */
export const SLOGAN_MS = 3500;

/** A random first slogan. `rand` returns [0, 1) (Math.random; injected in tests). */
export function firstSloganIndex(count: number, rand: () => number = Math.random): number {
  if (count <= 1) return 0;
  return Math.min(count - 1, Math.floor(clamp01(rand()) * count));
}

/** The next slogan: random, never the one showing now. */
export function nextSloganIndex(current: number, count: number, rand: () => number = Math.random): number {
  if (count <= 1) return 0;
  const step = 1 + Math.min(count - 2, Math.floor(clamp01(rand()) * (count - 1)));
  return (((current + step) % count) + count) % count;
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.max(0, Math.min(0.999999, x)) : 0;
}

/** The slogan to show now and a counter that changes with it (a React key restarts its animation). */
export function useSlogan(ms: number = SLOGAN_MS, slogans: readonly string[] = CV_SLOGANS, rand: () => number = Math.random): { text: string; n: number } {
  const [s, setS] = useState(() => ({ i: firstSloganIndex(slogans.length, rand), n: 0 }));
  useEffect(() => {
    const id = setInterval(() => setS((x) => ({ i: nextSloganIndex(x.i, slogans.length, rand), n: x.n + 1 })), ms);
    return () => clearInterval(id);
  }, [ms, slogans, rand]);
  return { text: slogans[s.i] ?? slogans[0] ?? "", n: s.n };
}

const SLOGAN_CSS = `
@keyframes cvSlogan{0%{opacity:0;transform:translate3d(0,40%,0)}12%{opacity:1;transform:translate3d(0,0,0)}88%{opacity:1;transform:translate3d(0,0,0)}100%{opacity:0;transform:translate3d(0,-40%,0)}}
.cv-slogan-line{animation:cvSlogan var(--cv-slogan-ms,3500ms) cubic-bezier(.2,.8,.2,1) both;will-change:transform,opacity}
@media (prefers-reduced-motion: reduce){.cv-slogan-line{animation:none}}
`;

/**
 * A slogan that changes every `ms` (slides up in, slides up out: transform
 * and opacity only). The box keeps its height, so nothing jumps.
 */
export function SloganTicker({ ms = SLOGAN_MS, className = "", style }: { ms?: number; className?: string; style?: CSSProperties }) {
  const { text, n } = useSlogan(ms);
  return (
    <div className={`overflow-hidden ${className}`} style={style} data-testid="cv-slogans" aria-live="off">
      <style>{SLOGAN_CSS}</style>
      <p key={n} data-testid="cv-slogan" data-n={n} className="cv-slogan-line" style={{ ["--cv-slogan-ms" as string]: `${ms}ms` } as CSSProperties}>
        {text}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- «Ленин в Октябре»

/** Searched for in the catalog (TMDB) at runtime; the 1937 film by Mikhail Romm. */
export const LENIN_QUERY = "Ленин в Октябре";
export const LENIN_YEAR = 1937;
const LENIN_TITLES = ["ленин в октябре", "lenin in october"];

export interface LeninCandidate {
  kind: string;
  title: string;
  original_title: string;
  year: number | null;
}

const norm = normTitle;

/**
 * The 1937 «Ленин в Октябре» among search results: a movie whose title or
 * original title is exactly that; the 1937 one, else the oldest such (a
 * 2010 documentary shares the name). Null when nothing matches.
 */
export function pickLeninInOctober<T extends LeninCandidate>(items: readonly T[] | null | undefined): T | null {
  const hits = (items ?? []).filter((m) => m.kind === "movie" && (LENIN_TITLES.includes(norm(m.title)) || LENIN_TITLES.includes(norm(m.original_title))));
  if (hits.length === 0) return null;
  const exact = hits.find((m) => m.year === LENIN_YEAR);
  if (exact) return exact;
  return [...hits].sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999))[0]!;
}

const CACHE_KEY = "martytv.cv.lenin";
const CACHE_TTL = 30 * 24 * 3600_000;

type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function local(): KV | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** The film found earlier on this device (for an instant card), or null when absent / stale / for another language. */
export function readLeninCache<T>(lang: string, now = Date.now(), store: KV | null = local()): T | null {
  try {
    const raw = store?.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as { lang?: string; at?: number; item?: T };
    if (!c.item || c.lang !== lang || typeof c.at !== "number" || now - c.at > CACHE_TTL) return null;
    return c.item;
  } catch {
    return null;
  }
}

export function writeLeninCache<T>(lang: string, item: T, now = Date.now(), store: KV | null = local()): void {
  try {
    store?.setItem(CACHE_KEY, JSON.stringify({ lang, at: now, item }));
  } catch {
    /* storage full / blocked: the search simply runs again */
  }
}

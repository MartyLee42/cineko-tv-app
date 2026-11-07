import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { UseInfiniteQueryResult } from "@tanstack/react-query";
import { ApiError, type MediaSummary } from "@martytv/contracts";
import { formatRating, imageUrl, placeholderColor, type ImageSize } from "@martytv/media-types";
import { CV_ERROR, CV_OFFLINE, hasQualityMark, QualityMark, Spinner, udarnikLabel, useConstructivism, useI18n, type MessageKey } from "@martytv/ui";
import { Button, ErrorText } from "../components";
import { CheckIcon, ChevronLeft, ChevronRight, HeartIcon, StarIcon } from "../icons";
import { isCatalogUnavailable, useCatalogConfig, type MediaPages } from "./queries";
import { usePosterTilt } from "./wobble";
import { AwardBadge } from "./Awards";
import { QuickActions, QuickSheet, useQuickSheet } from "../watch/QuickActions";
import { useLongPress } from "../watch/longPress";

type PosterItem = Pick<MediaSummary, "id" | "title" | "poster_path">;

/** <img> that falls back to `fallback` when the URL is missing or fails to load. */
export function Img({
  src,
  srcSet,
  sizes,
  alt,
  className = "",
  fallback,
  eager,
}: {
  src: string | null;
  srcSet?: string;
  sizes?: string;
  alt: string;
  className?: string;
  fallback: ReactNode;
  eager?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return <>{fallback}</>;
  return (
    <img
      src={src}
      srcSet={srcSet}
      sizes={sizes}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onError={() => setFailed(src)}
      className={className}
    />
  );
}

function srcSetFor(cfg: Parameters<typeof imageUrl>[0], path: string | null, sizes: [ImageSize, number][]) {
  const parts = sizes.map(([s, w]) => {
    const u = imageUrl(cfg, path, s);
    return u ? `${u} ${w}w` : null;
  });
  return parts.every(Boolean) ? parts.join(", ") : undefined;
}

/** 2:3 poster with a coloured title placeholder; never shifts layout. */
export function Poster({
  item,
  sizes = "(min-width: 768px) 160px, 112px",
  className = "",
  eager,
}: {
  item: PosterItem;
  sizes?: string;
  className?: string;
  eager?: boolean;
}) {
  const { data: cfg } = useCatalogConfig();
  const src = imageUrl(cfg, item.poster_path, "w342");
  return (
    <div
      className={`relative aspect-[2/3] overflow-hidden rounded-xl bg-surface-2 ${className}`}
      style={{ background: placeholderColor(item.title || item.id) }}
    >
      <Img
        src={src}
        srcSet={srcSetFor(cfg, item.poster_path, [
          ["w185", 185],
          ["w342", 342],
          ["w500", 500],
        ])}
        sizes={sizes}
        alt={item.title}
        eager={eager}
        className="absolute inset-0 h-full w-full object-cover"
        fallback={
          <div className="absolute inset-0 flex items-end p-2.5">
            <span className="line-clamp-4 text-sm font-semibold leading-snug text-white/90">{item.title}</span>
          </div>
        }
      />
    </div>
  );
}

export function RatingBadge({ rating, className = "" }: { rating: number | null | undefined; className?: string }) {
  const { locale } = useI18n();
  const cv = useConstructivism();
  const r = formatRating(rating);
  if (!r) return null;
  // «Конструктивизм»: high ratings are «ударник ★8,7».
  const udarnik = cv ? udarnikLabel(rating, locale) : null;
  if (udarnik) {
    return (
      <span data-testid="cv-udarnik" className={`inline-flex items-center bg-[#d7261e] px-1.5 py-0.5 font-display text-xs font-bold uppercase tracking-wide text-[#f8f0de] ${className}`}>
        {udarnik}
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-semibold text-white ${className}`}
    >
      <StarIcon className="text-accent" />
      {r}
    </span>
  );
}

/** «Конструктивизм»: the Soviet «Знак качества» on titles rated ≥ 8.5 (КП or TMDB). */
function QualityBadge({ item }: { item: Pick<MediaSummary, "rating" | "kp_rating"> }) {
  const cv = useConstructivism();
  if (!cv || !hasQualityMark([item.kp_rating, item.rating])) return null;
  return <QualityMark size={34} className="absolute bottom-1.5 right-1.5 drop-shadow" />;
}

export function PosterCard({ item, sizes, className = "" }: { item: MediaSummary; sizes?: string; className?: string }) {
  const { t } = useI18n();
  const tilt = usePosterTilt();
  const cv = useConstructivism();
  // Quick actions (♥, «Буду смотреть», rating) without opening the title: hover buttons, «⋯», long press.
  const quick = useQuickSheet();
  const press = useLongPress(quick.show, quick.enabled);
  return (
    <div className={`group/card relative ${className}`} {...press}>
      <Link to={`/title/${item.id}`} className="group block select-none outline-none [-webkit-touch-callout:none]" data-testid="poster-card">
        <div {...tilt} className="relative transition duration-200 group-hover/card:-translate-y-0.5 group-focus-visible:ring-2 group-focus-visible:ring-accent rounded-xl">
          <Poster item={item} sizes={sizes} className="shadow-lg shadow-black/30 ring-1 ring-black/5" />
          {/* «Конструктивизм» ranks by КП when known («ударник ★8,4»). */}
          <div className="absolute left-1.5 top-1.5 flex flex-col items-start gap-1">
            <RatingBadge rating={cv ? (item.kp_rating ?? item.rating) : item.rating} />
            <AwardBadge badge={item.award_badge} />
          </div>
          <QualityBadge item={item} />
          <MeBadges me={item.me} />
        </div>
        <p className="mt-2 line-clamp-2 text-sm font-medium leading-snug group-hover:text-accent-strong">{item.title}</p>
        <p className="mt-0.5 text-xs text-muted">
          {[item.year, t(`catalog.kind.${item.kind}` as MessageKey)].filter(Boolean).join(" · ")}
        </p>
      </Link>
      {quick.enabled && <QuickActions item={item} onMenu={quick.show} />}
      {quick.open && <QuickSheet item={item} anchor={quick.anchor} onClose={quick.close} />}
    </div>
  );
}

/** Watch state on a poster: progress line, watched check, favorite heart. */
export function MeBadges({ me }: { me: MediaSummary["me"] }) {
  const { t } = useI18n();
  if (!me) return null;
  const pct = me.progress_percent ?? 0;
  return (
    <>
      {(me.completed || me.favorite || me.rating != null) && (
        <div className="absolute right-1.5 top-1.5 flex flex-col items-center gap-1">
          {me.completed && (
            <span
              title={t("watch.watched")}
              data-testid="badge-watched"
              className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-sm text-on-accent shadow-md shadow-black/40"
            >
              <CheckIcon strokeWidth={3} />
              <span className="sr-only">{t("watch.watched")}</span>
            </span>
          )}
          {me.favorite && (
            <span
              title={t("lists.favorites")}
              data-testid="badge-favorite"
              className="flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-[13px] text-rose-400"
            >
              <HeartIcon filled />
            </span>
          )}
          {me.rating != null && (
            <span
              title={t("quick.rating")}
              data-testid="badge-my-rating"
              className="flex h-6 min-w-6 items-center justify-center rounded-full bg-black/70 px-1.5 text-[11px] font-bold text-amber-300 shadow-md shadow-black/40"
            >
              ★{me.rating}
            </span>
          )}
        </div>
      )}
      {!me.completed && pct > 0 && (
        <div className="absolute inset-x-1.5 bottom-1.5 h-1 overflow-hidden rounded-full bg-black/55" data-testid="badge-progress">
          <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(4, Math.round(pct * 100))}%` }} />
        </div>
      )}
    </>
  );
}

function PosterSkeleton({ className = "" }: { className?: string }) {
  return (
    <div className={className} aria-hidden>
      <div className="aspect-[2/3] animate-pulse rounded-xl bg-surface-2" />
      <div className="mt-2 h-3.5 w-4/5 animate-pulse rounded bg-surface-2" />
      <div className="mt-1.5 h-3 w-1/2 animate-pulse rounded bg-surface-2" />
    </div>
  );
}

const rowItem = "w-[7.25rem] shrink-0 snap-start sm:w-36 lg:w-40";

/** Horizontal scroll-snap row of posters with desktop arrow buttons. */
export function PosterRow({
  title,
  href,
  items,
  loading,
  testId,
}: {
  title: string;
  href?: string;
  items?: MediaSummary[];
  loading?: boolean;
  testId?: string;
}) {
  const { t } = useI18n();
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  const update = () => {
    const el = scroller.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 8 });
  };
  useEffect(update, [items]);

  const scroll = (dir: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
  };

  if (!loading && !items?.length) return null;

  return (
    <section className="group/row" data-testid={testId}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-bold sm:text-xl">{title}</h2>
        {href && (
          <Link to={href} className="shrink-0 py-2 text-sm font-medium text-muted hover:text-accent">
            {t("catalog.see_all")} →
          </Link>
        )}
      </div>
      <div className="relative">
        <div
          ref={scroller}
          onScroll={update}
          className="no-scrollbar -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 sm:gap-4 md:mx-0 md:scroll-px-0 md:px-0"
        >
          {loading && !items
            ? Array.from({ length: 8 }, (_, i) => <PosterSkeleton key={i} className={rowItem} />)
            : items!.map((m) => <PosterCard key={m.id} item={m} className={rowItem} />)}
        </div>
        <RowArrow dir={-1} hidden={edges.start} onClick={() => scroll(-1)} label={t("catalog.scroll_left")} />
        <RowArrow dir={1} hidden={edges.end} onClick={() => scroll(1)} label={t("catalog.scroll_right")} />
      </div>
    </section>
  );
}

function RowArrow({ dir, hidden, onClick, label }: { dir: 1 | -1; hidden: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      tabIndex={-1}
      className={`absolute top-[calc(50%-1.75rem)] z-[1] hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-bg/85 text-xl text-text shadow-xl backdrop-blur transition hover:bg-surface-2 md:flex ${
        dir < 0 ? "-left-3" : "-right-3"
      } ${hidden ? "pointer-events-none opacity-0" : "opacity-0 group-hover/row:opacity-100"}`}
    >
      {dir < 0 ? <ChevronLeft /> : <ChevronRight />}
    </button>
  );
}

export const gridCols = "grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 sm:gap-x-4 md:grid-cols-5";
export const gridSizes = "(min-width: 1024px) 180px, (min-width: 640px) 25vw, 33vw";

export function PosterGrid({ items, className = gridCols }: { items: MediaSummary[]; className?: string }) {
  return (
    <div className={className} data-testid="poster-grid">
      {items.map((m) => (
        <PosterCard key={m.id} item={m} sizes={gridSizes} />
      ))}
    </div>
  );
}

export function PosterGridSkeleton({ count = 15, className = gridCols }: { count?: number; className?: string }) {
  return (
    <div className={className}>
      {Array.from({ length: count }, (_, i) => (
        <PosterSkeleton key={i} />
      ))}
    </div>
  );
}

/**
 * Poster grid over an infinite query: loads the next page when the sentinel
 * scrolls into view, with a "load more" button as a fallback.
 */
export function InfinitePosterGrid({
  query,
  empty,
  className,
  filter,
}: {
  query: UseInfiniteQueryResult<MediaPages>;
  empty: ReactNode;
  className?: string;
  /** Client-side filter (e.g. hide watched where the API has no parameter). */
  filter?: (m: MediaSummary) => boolean;
}) {
  const { t } = useI18n();
  const sentinel = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const { data, error, isPending, isPlaceholderData, isFetching, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } =
    query;
  // While the previous tab's/filter's results are shown as a placeholder (or a
  // refresh runs), "load more" would page the NEW query to fill the OLD scroll
  // position — the endless-loading bug. Only load for settled results.
  const canLoad = !!hasNextPage && !isFetching && !isPlaceholderData && !error;

  // A tab/filter change swaps in placeholder data: jump back to the top of the
  // results if the user had scrolled past them.
  useEffect(() => {
    if (!isPlaceholderData || !top.current) return;
    const y = top.current.getBoundingClientRect().top + window.scrollY - 80;
    if (window.scrollY > y) window.scrollTo({ top: Math.max(0, y) });
  }, [isPlaceholderData]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !canLoad || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void fetchNextPage();
    }, { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [canLoad, fetchNextPage]);

  if (isPending) return <PosterGridSkeleton className={className} />;
  if (error && !data) return <CatalogError error={error} onRetry={() => refetch()} />;

  const seen = new Set<string>();
  const items = (data?.pages ?? [])
    .flatMap((p) => p.items)
    .filter((m) => !seen.has(m.id) && seen.add(m.id) && (!filter || filter(m)));
  if (!items.length) return <div className="py-16 text-center text-muted">{empty}</div>;

  return (
    <div ref={top} className={`transition-opacity ${isPlaceholderData ? "opacity-50" : ""}`}>
      <PosterGrid items={items} className={className} />
      <div ref={sentinel} className="flex min-h-[72px] items-center justify-center pt-6">
        {isFetchingNextPage ? (
          <Spinner />
        ) : error ? (
          <CatalogError error={error} onRetry={() => fetchNextPage()} />
        ) : hasNextPage ? (
          <Button variant="secondary" onClick={() => fetchNextPage()}>
            {t("catalog.load_more")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Full-bleed-on-mobile backdrop image with bottom/left fades into the page: the scrims (index.css
 *  .mt-scrim-*) keep text over it on the page colour whatever the picture (bright sky, night). */
export function Backdrop({
  path,
  title,
  className = "",
  eager,
}: {
  path: string | null;
  title: string;
  className?: string;
  eager?: boolean;
}) {
  const { data: cfg } = useCatalogConfig();
  return (
    <div className={`absolute inset-0 ${className}`} style={{ background: placeholderColor(title) }}>
      <Img
        src={imageUrl(cfg, path, "w1280")}
        srcSet={srcSetFor(cfg, path, [
          ["w780", 780],
          ["w1280", 1280],
        ])}
        sizes="(min-width: 1152px) 1152px, 100vw"
        alt=""
        eager={eager}
        className="h-full w-full object-cover object-top"
        fallback={null}
      />
      <div className="mt-scrim-b absolute inset-0" />
      <div className="mt-scrim-l absolute inset-0 hidden sm:block" />
    </div>
  );
}

export function Unavailable() {
  const { t } = useI18n();
  return (
    <div className="rounded-2xl border border-dashed border-border bg-surface px-6 py-12 text-center text-muted" data-testid="catalog-unavailable">
      {t("catalog.unavailable")}
    </div>
  );
}

export function CatalogError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  const cv = useConstructivism();
  if (isCatalogUnavailable(error)) return <Unavailable />;
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      {cv && error ? (
        // «Конструктивизм»: the error in the poster voice.
        <p role="alert" data-testid="cv-error" className="font-display text-xl font-bold uppercase text-text sm:text-2xl">
          {error instanceof ApiError && error.code === "network_error" ? CV_OFFLINE : CV_ERROR}
        </p>
      ) : (
        <ErrorText error={error} />
      )}
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}

/** Wraps a catalog page: shows the unavailable state up front and the TMDB attribution below. */
export function CatalogPage({ children }: { children: ReactNode }) {
  const { data: cfg } = useCatalogConfig();
  return (
    <>
      {cfg?.available === false ? <Unavailable /> : children}
      <CatalogFooter />
    </>
  );
}

export function CatalogFooter() {
  const { t } = useI18n();
  return (
    <footer className="mt-12 border-t border-border pt-5 text-xs leading-relaxed text-muted">
      <p>
        {t("catalog.attribution")}{" "}
        <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer" className="whitespace-nowrap underline hover:text-text">
          {t("catalog.tmdb_source")}
        </a>
      </p>
    </footer>
  );
}

/** Segmented tabs (role=tablist) used by browse and search. */
export function Tabs<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-xl border border-border bg-surface p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={`min-h-[40px] rounded-lg px-4 text-sm font-semibold transition ${
            o.value === value ? "bg-surface-2 text-text shadow" : "text-muted hover:text-text"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

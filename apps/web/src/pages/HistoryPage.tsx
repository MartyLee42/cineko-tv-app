import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import type { HistoryItem } from "@martytv/contracts";
import { episodeCode, imageUrl, placeholderColor } from "@martytv/media-types";
import {
  historyDate,
  historyView,
  isFiltered,
  monthLabel,
  normalizeSearch,
  Spinner,
  useI18n,
  type HistoryKind,
  type MessageKey,
} from "@martytv/ui";
import { Button, timeAgo } from "../components";
import { CatalogError, Img } from "../catalog/components";
import { useCatalogConfig } from "../catalog/queries";
import { CheckIcon, CloseIcon, SearchIcon } from "../icons";
import { useActiveProfile } from "../watch/ActiveProfile";
import { useHistory } from "../watch/queries";
import { ProgressBar } from "../watch/components";

export function NoProfile() {
  const { t } = useI18n();
  return (
    <div className="rounded-2xl border border-dashed border-border bg-surface px-6 py-10 text-center text-muted">
      <p>{t("settings.no_profile")}</p>
      <Link to="/profiles" className="mt-4 inline-flex min-h-[44px] items-center rounded-xl bg-accent px-5 font-semibold text-on-accent">
        {t("profiles.add")}
      </Link>
    </div>
  );
}

const KINDS: { id: HistoryKind; label: MessageKey }[] = [
  { id: "all", label: "fy.history.all" },
  { id: "movie", label: "fy.history.movies" },
  { id: "series", label: "fy.history.series" },
  { id: "rated", label: "fy.history.rated" },
];
/** With a filter on, keep loading pages until this many matches show (or the end). */
const FILTER_FILL = 40;

/**
 * «История»: the active profile's watch history, newest first, grouped by
 * month with the profile's rating. Filters and search run over loaded pages;
 * a search loads the whole history (thousands of imported ratings) so it
 * finds everything.
 */
export function HistoryPage() {
  const { t } = useI18n();
  const { profile } = useActiveProfile();
  const [params, setParams] = useSearchParams();
  const kindParam = params.get("f");
  const kind: HistoryKind = kindParam === "movie" || kindParam === "series" || kindParam === "rated" ? kindParam : "all";
  const [q, setQ] = useState(params.get("q") ?? "");
  const filter = useMemo(() => ({ kind, q }), [kind, q]);
  const hq = useHistory(100);
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isError } = hq;

  const all = useMemo(() => hq.data?.pages.flatMap((p) => p.items) ?? [], [hq.data]);
  const groups = useMemo(() => historyView(all, filter), [all, filter]);
  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  const searching = normalizeSearch(q) !== "";
  const filtered = isFiltered(filter);

  // Filters: fill the screen; search: everything (newest pages first).
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage || isError) return;
    if (searching || (filtered && shown < FILTER_FILL)) void fetchNextPage();
  }, [searching, filtered, shown, hasNextPage, isFetchingNextPage, isError, fetchNextPage]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || isFetchingNextPage || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void fetchNextPage(), {
      rootMargin: "800px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, groups.length]);

  const setKind = (k: HistoryKind) => {
    const next = new URLSearchParams(params);
    if (k === "all") next.delete("f");
    else next.set("f", k);
    setParams(next, { replace: true });
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">{t("watch.history")}</h1>
          {profile && <p className="mt-0.5 text-sm text-muted">{profile.name}</p>}
        </div>
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 text-sm font-semibold sm:mx-0 sm:px-0">
          <Link to="/diary" data-testid="history-diary" className="flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-xl bg-accent/15 px-3.5 text-text hover:bg-accent/25">
            📅 {t("nav.diary")}
          </Link>
          <Link to="/taste" data-testid="history-taste" className="flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-xl bg-accent/15 px-3.5 text-text hover:bg-accent/25">
            🧬 {t("nav.taste")}
          </Link>
          <Link to="/notes" data-testid="history-notes" className="flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-xl bg-accent/15 px-3.5 text-text hover:bg-accent/25">
            📝 {t("taste.notes.title")}
          </Link>
          <Link to="/lists/watchlist" className="flex min-h-[40px] shrink-0 items-center rounded-xl bg-surface-2 px-3.5 hover:bg-border">
            {t("lists.watchlist")}
          </Link>
          <Link to="/lists/favorites" className="flex min-h-[40px] shrink-0 items-center rounded-xl bg-surface-2 px-3.5 hover:bg-border">
            {t("lists.favorites")}
          </Link>
        </div>
      </div>
      {!profile ? (
        <NoProfile />
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div role="tablist" aria-label={t("watch.history")} className="no-scrollbar flex gap-1 overflow-x-auto rounded-xl border border-border bg-surface p-1" data-testid="history-filters">
              {KINDS.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  role="tab"
                  aria-selected={kind === k.id}
                  data-filter={k.id}
                  onClick={() => setKind(k.id)}
                  className={`min-h-[36px] shrink-0 rounded-lg px-3.5 text-sm font-semibold transition ${kind === k.id ? "bg-surface-2 text-text shadow" : "text-muted hover:text-text"}`}
                >
                  {t(k.label)}
                </button>
              ))}
            </div>
            <label className="relative flex-1 sm:max-w-xs sm:ml-auto">
              <span className="sr-only">{t("fy.history.search")}</span>
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("fy.history.search")}
                data-testid="history-search"
                className="min-h-[44px] w-full rounded-xl border border-border bg-bg pl-9 pr-9 text-text outline-none focus:border-accent"
              />
              {q && (
                <button type="button" aria-label={t("common.close")} onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted hover:text-text">
                  <CloseIcon />
                </button>
              )}
            </label>
          </div>
          {hq.isPending ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : hq.error && !hq.data ? (
            <CatalogError error={hq.error} onRetry={() => hq.refetch()} />
          ) : !all.length ? (
            <p className="py-16 text-center text-muted">{t("watch.history_empty")}</p>
          ) : (
            <>
              {searching && hasNextPage && (
                <p className="mb-3 flex items-center gap-2 text-sm text-muted" data-testid="history-loading-all">
                  <Spinner size={16} /> {t("fy.history.loading_all", { n: all.length })}
                </p>
              )}
              {!groups.length && !hasNextPage ? (
                <p className="py-16 text-center text-muted" data-testid="history-no-match">
                  {t("fy.history.no_match")}
                </p>
              ) : (
                <div className="space-y-6" data-testid="history-list">
                  {groups.map((g) => (
                    <section key={g.key} data-testid="history-month" data-month={g.key} className="[content-visibility:auto] [contain-intrinsic-size:auto_600px]">
                      <h2 className="sticky top-14 z-[5] -mx-4 mb-2 flex items-baseline gap-2 bg-bg/90 px-4 py-2 text-base font-bold backdrop-blur sm:mx-0 sm:rounded-xl sm:px-2">
                        {monthLabel(g.key, t)}
                        <span className="text-xs font-medium text-muted">{g.items.length}</span>
                      </h2>
                      <ol className="space-y-2">
                        {g.items.map((h) => (
                          <HistoryRow key={`${h.media.id}-${h.progress.episode_id ?? ""}-${h.progress.updated_at}`} h={h} absolute />
                        ))}
                      </ol>
                    </section>
                  ))}
                </div>
              )}
              <div ref={sentinel} className="flex min-h-[64px] items-center justify-center pt-4">
                {isFetchingNextPage ? (
                  <Spinner />
                ) : hasNextPage ? (
                  <Button variant="secondary" onClick={() => fetchNextPage()}>
                    {t("catalog.load_more")}
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** "★ 9": the profile's own rating (colour by value). */
export function RatingChip({ value, className = "" }: { value: number; className?: string }) {
  const { t } = useI18n();
  const tone = value >= 8 ? "bg-ok/15 text-ok" : value >= 6 ? "bg-accent/15 text-text" : "bg-danger/15 text-danger";
  return (
    <span data-testid="rating-chip" title={t("fy.history.your_rating", { n: value })} className={`inline-flex shrink-0 items-center gap-0.5 rounded-lg px-2 py-1 text-sm font-bold tabular-nums ${tone} ${className}`}>
      ★ {value}
    </span>
  );
}

function shortDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: "UTC" });
}

export function HistoryRow({ h, extra, absolute }: { h: HistoryItem; extra?: ReactNode; absolute?: boolean }) {
  const { t, locale } = useI18n();
  const { data: cfg } = useCatalogConfig();
  const p = h.progress;
  const code = p.season_number != null && p.episode_number != null ? episodeCode(p.season_number, p.episode_number) : null;
  const href = `/title/${h.media.id}${code ? `?season=${p.season_number}&episode=${p.episode_number}` : ""}`;
  const rating = h.media.me?.rating ?? null;
  const when = absolute ? shortDate(historyDate(h), locale) : timeAgo(p.completed_at ?? p.updated_at, locale);
  return (
    <li data-testid="history-row">
      <Link to={href} className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-2.5 hover:border-muted">
        <div className="relative aspect-[2/3] w-12 shrink-0 overflow-hidden rounded-lg" style={{ background: placeholderColor(h.media.title) }}>
          <Img src={imageUrl(cfg, h.media.poster_path, "w185")} alt="" className="absolute inset-0 h-full w-full object-cover" fallback={null} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{h.media.title}</p>
          <p className="truncate text-xs text-muted">
            {[absolute ? h.media.year : null, absolute ? t(`catalog.kind.${h.media.kind}` as MessageKey) : null, code, when].filter(Boolean).join(" · ")}
          </p>
          {extra}
          {!p.completed && <ProgressBar value={p.percent} className="mt-1.5 max-w-[12rem]" />}
        </div>
        {absolute && rating != null && <RatingChip value={rating} />}
        {p.completed ? (
          <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-ok" title={t("watch.watched")}>
            <CheckIcon /> <span className={absolute ? "sr-only sm:not-sr-only" : ""}>{t("watch.watched")}</span>
          </span>
        ) : (
          absolute && <span className="shrink-0 text-xs font-semibold text-muted">{t("fy.history.in_progress")}</span>
        )}
      </Link>
    </li>
  );
}

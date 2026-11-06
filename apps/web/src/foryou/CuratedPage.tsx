import { useState } from "react";
import { Link, useParams } from "react-router";
import { imageUrl, placeholderColor } from "@martytv/media-types";
import { curatedGroupTitle, curatedPercent, curatedProgressLabel, orderCuratedGroups, Spinner, unwatchedCurated, useI18n, type MessageKey } from "@martytv/ui";
import { Backdrop, CatalogError, CatalogPage, gridCols, gridSizes, Img, PosterCard } from "../catalog/components";
import { isNotFound, useCatalogConfig } from "../catalog/queries";
import { ChevronLeft } from "../icons";
import { NoProfile } from "../pages/HistoryPage";
import { useActiveProfile } from "../watch/ActiveProfile";
import { useCuratedList, useCuratedLists, type CuratedItem, type CuratedListSummary } from "./queries";

function BackToExplore() {
  const { t } = useI18n();
  return (
    <Link to="/explore" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
      <ChevronLeft /> {t("fy.explore.title")}
    </Link>
  );
}

function ProgressBar({ watched, count, className = "" }: { watched: number; count: number; className?: string }) {
  const pct = curatedPercent(watched, count);
  return (
    <div className={`h-1.5 overflow-hidden rounded-full bg-border ${className}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
    </div>
  );
}

function Loading() {
  return (
    <div className="flex justify-center py-16">
      <Spinner />
    </div>
  );
}

/** «Подборки» (/curated): curated film lists by group, with the profile's progress. */
export function CuratedShelfPage() {
  const { t } = useI18n();
  const { profile } = useActiveProfile();
  const q = useCuratedLists();
  const groups = q.data ? orderCuratedGroups(q.data).filter((g) => g.lists.length) : [];
  return (
    <CatalogPage>
      <div className="space-y-8" data-testid="curated-shelf">
        <div className="space-y-3">
          <BackToExplore />
          <header>
            <h1 className="text-2xl font-bold sm:text-3xl">{t("curated.title")}</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">{t("curated.subtitle")}</p>
          </header>
        </div>
        {!profile ? (
          <NoProfile />
        ) : q.isPending ? (
          <Loading />
        ) : q.error ? (
          <CatalogError error={q.error} onRetry={() => q.refetch()} />
        ) : !groups.length ? (
          <p className="py-16 text-center text-muted">{t("curated.empty")}</p>
        ) : (
          groups.map((g) => (
            <section key={g.id} data-testid="curated-group" data-group={g.id}>
              <h2 className="mb-3 text-lg font-bold sm:text-xl">{curatedGroupTitle(g.id, t, g.title)}</h2>
              <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
                {g.lists.map((l) => (
                  <ListCard key={l.id} list={l} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </CatalogPage>
  );
}

function ListCard({ list }: { list: CuratedListSummary }) {
  const { t } = useI18n();
  const { data: cfg } = useCatalogConfig();
  const covers = list.covers.slice(0, 4);
  return (
    <Link
      to={`/curated/${encodeURIComponent(list.id)}`}
      data-testid="curated-card"
      data-list={list.id}
      className="group flex gap-3 rounded-2xl border border-border bg-surface p-3 outline-none transition hover:-translate-y-0.5 hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent"
    >
      {/* Up to four covers, fanned like a stack of tickets. */}
      <div className="flex shrink-0 self-start" aria-hidden>
        {(covers.length ? covers : [null]).map((p, i) => (
          <div
            key={i}
            className={`relative aspect-[2/3] w-16 shrink-0 overflow-hidden rounded-lg shadow-md shadow-black/30 ring-1 ring-black/10 sm:w-[4.5rem] ${i ? "-ml-10 sm:-ml-11" : ""}`}
            style={{ background: placeholderColor(`${list.id}${i}`), zIndex: 4 - i }}
          >
            <Img src={imageUrl(cfg, p, "w185")} alt="" className="absolute inset-0 h-full w-full object-cover" fallback={null} />
          </div>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="line-clamp-2 font-bold leading-snug group-hover:text-accent-strong">{list.title}</p>
        <p className="mt-0.5 truncate text-xs text-muted">{list.author}</p>
        <div className="mt-auto pt-3">
          <ProgressBar watched={list.watched} count={list.count} />
          <p className="mt-1 text-xs tabular-nums text-muted" data-testid="curated-card-progress">
            {curatedProgressLabel(list.watched, list.count, t, true)}
          </p>
        </div>
      </div>
    </Link>
  );
}

/** One curated list (/curated/:id): header, progress and its films in list order. */
export function CuratedListPage() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const { profile } = useActiveProfile();
  const q = useCuratedList(id);
  const [unwatched, setUnwatched] = useState(false);
  const c = q.data;
  const hero = c?.items.find((it) => it.media?.backdrop_path)?.media ?? null;
  const items = c ? (unwatched ? unwatchedCurated(c.items) : c.items) : [];
  return (
    <CatalogPage>
      <div className="space-y-6">
        <BackToExplore />
        {!profile ? (
          <NoProfile />
        ) : q.isPending ? (
          <Loading />
        ) : q.error ? (
          isNotFound(q.error) ? (
            <p className="py-16 text-center text-muted" data-testid="curated-missing">
              {t("curated.not_found")}
            </p>
          ) : (
            <CatalogError error={q.error} onRetry={() => q.refetch()} />
          )
        ) : !c ? null : (
          <>
            <section className="relative -mx-4 overflow-hidden sm:mx-0 sm:rounded-3xl" data-testid="curated-list" data-list={c.id}>
              {hero && <Backdrop path={hero.backdrop_path} title={hero.title} />}
              <div className={`relative flex flex-col gap-3 px-5 pb-6 sm:max-w-3xl sm:px-10 sm:pb-9 ${hero ? "min-h-[320px] justify-end pt-20 sm:min-h-[360px]" : "pt-6"}`}>
                <Link to="/curated" className="w-fit rounded-full bg-black/40 px-2.5 py-0.5 text-xs font-semibold text-white/90 hover:bg-black/60">
                  {t("curated.title")} · {curatedGroupTitle(c.group, t, c.group)}
                </Link>
                <h1 className="text-3xl font-extrabold leading-tight drop-shadow sm:text-4xl" data-testid="curated-title">
                  {c.title}
                </h1>
                <p className="text-sm font-semibold">{c.author}</p>
                {c.description && <p className="max-w-2xl text-sm leading-relaxed text-text/85 sm:text-base">{c.description}</p>}
                <p className="text-xs text-muted">
                  {t("curated.source", { source: c.source })}
                  {c.source_url && (
                    <>
                      {" · "}
                      <a href={c.source_url} target="_blank" rel="noreferrer noopener" className="underline hover:text-accent" data-testid="curated-source-link">
                        {t("curated.source_link")}
                      </a>
                    </>
                  )}
                </p>
                <div className="max-w-md pt-1">
                  <ProgressBar watched={c.watched} count={c.count} className="h-2" />
                  <p className="mt-1.5 text-sm font-semibold tabular-nums" data-testid="curated-progress">
                    {curatedProgressLabel(c.watched, c.count, t)}
                  </p>
                </div>
              </div>
            </section>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted">{t("curated.count", { n: c.count })}</p>
              <button
                type="button"
                data-testid="curated-filter"
                aria-pressed={unwatched}
                onClick={() => setUnwatched((v) => !v)}
                className={`flex min-h-[40px] items-center rounded-full px-4 text-sm font-semibold transition ${unwatched ? "bg-accent text-on-accent hover:bg-accent-strong" : "bg-surface-2 hover:bg-border"}`}
              >
                {t(unwatched ? "curated.show_all" : "curated.unwatched_only")}
              </button>
            </div>
            {items.length ? (
              <div className={gridCols}>
                {items.map((it) => (
                  <ItemCard key={it.position} item={it} ranked={c.ordered} />
                ))}
              </div>
            ) : (
              <p className="py-16 text-center text-muted" data-testid="curated-done">
                {t(unwatched ? "curated.all_watched" : "fy.browse.empty")}
              </p>
            )}
          </>
        )}
      </div>
    </CatalogPage>
  );
}

function ItemCard({ item, ranked }: { item: CuratedItem; ranked: boolean }) {
  const { t } = useI18n();
  const m = item.media;
  // «Watched» here also counts a rating; show the same ✓ as a finished title.
  const media = m && item.watched && m.me && !m.me.completed ? { ...m, me: { ...m.me, completed: true } } : m;
  return (
    <div data-testid="curated-item" data-watched={item.watched ? "true" : "false"} data-position={item.position}>
      {ranked && item.rank != null && <p className="mb-1 text-xs font-bold tabular-nums text-accent-strong">{t("curated.rank", { n: item.rank })}</p>}
      {media ? (
        <PosterCard item={media} sizes={gridSizes} />
      ) : (
        <div data-testid="curated-missing-item">
          <div className="flex aspect-[2/3] flex-col justify-end rounded-xl border border-dashed border-border bg-surface-2 p-2.5">
            <span className="line-clamp-4 text-sm font-semibold leading-snug text-muted">{item.title}</span>
          </div>
          <p className="mt-2 line-clamp-2 text-sm font-medium leading-snug">{item.title}</p>
          <p className="mt-0.5 text-xs text-muted">
            {[item.year || null, t(`catalog.kind.${item.kind}` as MessageKey)].filter(Boolean).join(" · ")}
          </p>
          <p className="mt-0.5 text-xs font-semibold text-muted">{t("curated.missing")}</p>
        </div>
      )}
      {item.note && <p className="mt-1 line-clamp-3 text-xs italic leading-snug text-muted">{item.note}</p>}
    </div>
  );
}

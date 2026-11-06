import { useRef } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { MediaKind } from "@martytv/contracts";
import { imageUrl, placeholderColor } from "@martytv/media-types";
import { useI18n } from "@martytv/ui";
import { CatalogError, CatalogPage, Img, InfinitePosterGrid, Tabs } from "../catalog/components";
import { useCatalogConfig } from "../catalog/queries";
import { ChevronLeft, ChevronRight, GridIcon } from "../icons";
import { NoProfile } from "../pages/HistoryPage";
import { useActiveProfile } from "../watch/ActiveProfile";
import { useBrowseTile, useExplore, type ExploreSection, type ExploreTile } from "./queries";
import { RegenButton } from "./RegenButton";
import { AskAiCard } from "./AskPage";

/** Where a tile leads: a collection page, or the tile's titles. */
export function tileHref(tile: ExploreTile): string {
  if (tile.kind === "collection" && tile.collection_id) return `/collections/${tile.collection_id}`;
  if (tile.kind === "curated" && tile.curated_id) return `/curated/${encodeURIComponent(tile.curated_id)}`;
  return `/explore/${encodeURIComponent(tile.id)}?title=${encodeURIComponent(tile.title)}`;
}

/** «Обзор»: data-driven sections of tiles (moods, decades, countries, genres, keywords, AI collections). */
export function ExplorePage() {
  const { t } = useI18n();
  const { profile } = useActiveProfile();
  const q = useExplore();
  return (
    <CatalogPage>
      <div className="space-y-8 sm:space-y-10">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold sm:text-3xl">{t("fy.explore.title")}</h1>
            <p className="mt-1 text-sm text-muted">{t("fy.explore.subtitle")}</p>
          </div>
          <div className="flex gap-2 text-sm font-semibold">
            <Link to="/surprise" className="flex min-h-[44px] items-center gap-2 rounded-xl bg-accent px-4 text-on-accent hover:bg-accent-strong">
              🎲 {t("nav.surprise")}
            </Link>
            <Link to="/browse" data-testid="explore-catalog" className="flex min-h-[44px] items-center gap-2 rounded-xl bg-surface-2 px-4 hover:bg-border">
              <GridIcon /> {t("fy.explore.catalog")}
            </Link>
          </div>
        </header>
        <AskAiCard />
        {!profile ? (
          <NoProfile />
        ) : q.isPending ? (
          <div className="space-y-8" aria-hidden>
            {[0, 1, 2].map((i) => (
              <div key={i}>
                <div className="mb-3 h-6 w-48 animate-pulse rounded bg-surface-2" />
                <div className="flex gap-3 overflow-hidden">
                  {Array.from({ length: 6 }, (_, j) => (
                    <div key={j} className="h-24 w-44 shrink-0 animate-pulse rounded-2xl bg-surface-2" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : q.error ? (
          <CatalogError error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data.length ? (
          <p className="py-16 text-center text-muted">{t("fy.explore.empty")}</p>
        ) : (
          q.data.filter((s) => s.tiles.length).map((s) => <SectionRow key={s.id} section={s} />)
        )}
      </div>
    </CatalogPage>
  );
}

function SectionRow({ section }: { section: ExploreSection }) {
  const { t } = useI18n();
  const scroller = useRef<HTMLDivElement>(null);
  const scroll = (dir: 1 | -1) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.85, behavior: "smooth" });
  const ai = section.kind === "collections";
  const curated = section.kind === "curated";
  const big = ai || curated;
  return (
    <section className="group/row" data-testid={`explore-${section.kind}`}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <h2 className="flex items-center gap-2 text-lg font-bold sm:text-xl">
          {section.title}
          {ai && <AiBadge />}
        </h2>
        {ai && <RegenButton />}
        {curated && (
          <Link to="/curated" data-testid="curated-all-link" className="shrink-0 py-1 text-sm font-medium text-muted hover:text-accent">
            {t("curated.all")} →
          </Link>
        )}
      </div>
      <div className="relative">
        <div ref={scroller} className="no-scrollbar -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 md:mx-0 md:scroll-px-0 md:px-0">
          {section.tiles.map((tile) => (
            <Tile key={tile.id} tile={tile} big={big} />
          ))}
        </div>
        {section.tiles.length > 4 && (
          <>
            <button type="button" tabIndex={-1} aria-label={t("catalog.scroll_left")} onClick={() => scroll(-1)} className="absolute -left-3 top-1/2 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-bg/85 opacity-0 shadow-xl backdrop-blur transition group-hover/row:opacity-100 md:flex">
              <ChevronLeft />
            </button>
            <button type="button" tabIndex={-1} aria-label={t("catalog.scroll_right")} onClick={() => scroll(1)} className="absolute -right-3 top-1/2 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-bg/85 opacity-0 shadow-xl backdrop-blur transition group-hover/row:opacity-100 md:flex">
              <ChevronRight />
            </button>
          </>
        )}
      </div>
    </section>
  );
}

export function AiBadge({ className = "" }: { className?: string }) {
  const { t } = useI18n();
  return (
    <span data-testid="ai-badge" className={`inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-fuchsia-500 to-amber-400 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white shadow ${className}`}>
      ✦ {t("fy.collection.badge")}
    </span>
  );
}

function Tile({ tile, big }: { tile: ExploreTile; big: boolean }) {
  const { data: cfg } = useCatalogConfig();
  const img = imageUrl(cfg, tile.image_path, "w780");
  const size = big ? "h-36 w-72 sm:h-40 sm:w-80" : tile.kind === "decade" ? "h-24 w-36 sm:w-40" : "h-24 w-44 sm:h-28 sm:w-52";
  return (
    <Link
      to={tileHref(tile)}
      data-testid="explore-tile"
      data-tile={tile.id}
      className={`group relative flex shrink-0 snap-start overflow-hidden rounded-2xl p-3 text-white shadow-lg shadow-black/20 ring-1 ring-black/5 outline-none transition hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-accent ${size}`}
      style={{ background: placeholderColor(tile.id) }}
    >
      {img && <Img src={img} alt="" className="absolute inset-0 h-full w-full object-cover transition duration-300 group-hover:scale-105" fallback={null} />}
      <span className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-black/5" aria-hidden />
      {tile.progress && (
        <span data-testid="explore-tile-progress" className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-semibold tabular-nums text-white">
          {tile.progress}
        </span>
      )}
      {tile.emoji && !img && <span className="absolute right-2 top-1 text-4xl drop-shadow sm:text-5xl" aria-hidden>{tile.emoji}</span>}
      <span className="relative mt-auto min-w-0">
        <span className={`block font-bold leading-tight drop-shadow ${big ? "line-clamp-2 text-lg" : tile.kind === "decade" ? "text-2xl" : "line-clamp-2 text-base"}`}>{tile.title}</span>
        {tile.subtitle && <span className={`mt-0.5 block text-xs text-white/80 ${big ? "line-clamp-2" : "truncate"}`}>{tile.subtitle}</span>}
      </span>
    </Link>
  );
}

/** One tile's titles (/explore/:tile). */
export function ExploreTilePage() {
  const { t } = useI18n();
  const { tile = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const kindParam = params.get("kind");
  const kind: MediaKind | undefined = kindParam === "movie" || kindParam === "series" ? kindParam : undefined;
  const q = useBrowseTile(tile, kind);
  const title = q.data?.pages[0]?.title ?? params.get("title") ?? tile;
  const tabs: { value: "all" | MediaKind; label: string }[] = [
    { value: "all", label: t("fy.browse.all") },
    { value: "movie", label: t("fy.browse.movies") },
    { value: "series", label: t("fy.browse.series") },
  ];
  const showTabs = !tile.startsWith("collection:");
  return (
    <CatalogPage>
      <div className="space-y-5">
        <Link to="/explore" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
          <ChevronLeft /> {t("fy.explore.title")}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold sm:text-3xl" data-testid="tile-title">
            {title}
          </h1>
          {showTabs && (
            <Tabs
              value={kind ?? "all"}
              options={tabs}
              label={t("fy.surprise.kind")}
              onChange={(v) => {
                const next = new URLSearchParams(params);
                if (v === "all") next.delete("kind");
                else next.set("kind", v);
                setParams(next, { replace: true });
              }}
            />
          )}
        </div>
        <InfinitePosterGrid query={q} empty={t("fy.browse.empty")} />
      </div>
    </CatalogPage>
  );
}

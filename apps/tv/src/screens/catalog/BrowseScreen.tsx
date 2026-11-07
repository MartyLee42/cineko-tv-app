import { useState } from "react";
import type { Genre, MediaKind, MediaSummary } from "@martytv/contracts";
import { Spinner, useI18n } from "@martytv/ui";
import { FocusBlock, FocusButton, FocusLine, useInitialFocus } from "../../focus";
import { cardKey } from "../../catalog/focusKeys";
import type { RouteMemory } from "../../catalog/nav";
import { isUnavailable, SORTS, useCatalogConfig, useDiscover, useGenres, type SortKey } from "../../catalog/queries";
import { nearEnd } from "../../catalog/virtual";
import { HRow } from "../../components/HRow";
import { VGrid } from "../../components/VGrid";
import { useDesign, useFrame } from "../../design/context";
import { GridCard, gridGeo, ScreenTitle } from "../../design/grid";
import { useReportDeep, useToTop } from "../../design/topJump";
import { ErrorState, GridSkeleton } from "../../components/States";

/** Room left of the text column so focus frames / brackets aren't clipped. */
const EDGE = 40;
/** Where a scrolled-to grid row lands (below the top chrome and the frame). */
const ROW_TOP = 110;
const GRID_TOP = 270;
const SORT_W = 400;

type Chip = { id: number | null; name: string };

export function BrowseScreen({ kind, mem, onOpen }: { kind: MediaKind; mem: RouteMemory; onOpen: (item: MediaSummary, from?: string) => void }) {
  const { t } = useI18n();
  const design = useDesign();
  const frame = useFrame();
  const width = 1920 - frame.x - 72;
  const g = gridGeo(design, width);
  const COLS = g.cols;
  const title = kind === "movie" ? t("catalog.movies") : t("catalog.series");
  const cfg = useCatalogConfig();
  const genres = useGenres(kind);
  const [genre, setGenre] = useState<number | null>(() => mem.get<number | null>("genre") ?? null);
  const [sort, setSort] = useState<SortKey>(() => mem.get<SortKey>("sort") ?? "popularity");
  const [ty, setTy] = useState(() => mem.get<number>("ty") ?? 0);
  const list = useDiscover(kind, genre, sort);
  const items = list.data?.items ?? [];

  const chips: Chip[] = [{ id: null, name: t("catalog.tv.all_genres") }, ...(genres.data ?? []).map((g: Genre) => ({ id: g.id, name: g.name }))];

  useInitialFocus(!list.isPending, mem, () => (items[0] ? cardKey("b", items[0].id) : "b-sort"));

  const scroll = (v: number) => {
    setTy(v);
    mem.set("ty", v);
  };
  const resetGrid = () => {
    mem.set("idx", 0);
    scroll(0);
  };
  const pickGenre = (id: number | null) => {
    if (id === genre) return;
    setGenre(id);
    mem.set("genre", id);
    resetGrid();
  };
  const cycleSort = () => {
    const next = SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length]!;
    setSort(next);
    mem.set("sort", next);
    resetGrid();
  };
  const onIndex = (i: number) => {
    mem.set("idx", i);
    const row = Math.floor(i / COLS);
    scroll(row === 0 ? 0 : GRID_TOP + row * g.pitchY - ROW_TOP);
    if (nearEnd(i, items.length, COLS * 3) && list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
  };

  // Back / Channel▲: the page returns to its top while focus goes to the menu.
  useToTop(() => {
    scroll(0);
    return false;
  });
  useReportDeep(ty > 0);

  let grid: React.ReactNode;
  if (list.isError) {
    grid = <ErrorState focusKey="b-retry" error={list.error} unavailable={isUnavailable(list.error, cfg.data)} onRetry={() => void list.refetch()} />;
  } else if (list.isPending) {
    grid = <GridSkeleton cols={COLS} width={g.w} height={g.h} pitchX={g.pitchX} pitchY={g.pitchY} />;
  } else if (items.length === 0) {
    grid = <p className="text-3xl text-muted">{t("catalog.no_results")}</p>;
  } else {
    grid = (
      <VGrid
        key={`${genre}-${sort}`}
        focusKey="b-grid"
        items={items}
        itemKey={(it) => cardKey("b", it.id)}
        cols={COLS}
        itemWidth={g.w}
        pitchX={g.pitchX}
        pitchY={g.pitchY}
        initialIndex={mem.get<number>("idx") ?? 0}
        onIndexChange={onIndex}
        onSelect={(it) => onOpen(it, title)}
        quick={(it) => ({ item: it, onOpen: () => onOpen(it, title) })}
        renderItem={(it, focused, i) => <GridCard item={it} cfg={cfg.data} g={g} focused={focused} index={i} />}
      />
    );
  }

  return (
    <div className="absolute overflow-hidden" style={{ left: frame.x - EDGE, right: 0, top: frame.top, bottom: 1080 - frame.bottom }}>
      <FocusLine
        focusKey="b-page"
        keys={items.length > 0 ? ["b-filters", "b-grid"] : ["b-filters"]}
        className="tv-track absolute right-0 top-0"
        style={{ left: EDGE, transform: `translate3d(0,${-ty}px,0)` }}
      >
        <div className="flex h-[136px] items-end pb-6">
          <ScreenTitle design={design} index={kind === "movie" ? 2 : 3}>
            {title}
          </ScreenTitle>
          {list.data && <span className="mb-1 ml-6 text-2xl text-muted">{t("catalog.tv.results", { n: list.data.total })}</span>}
          {list.isFetchingNextPage && (
            <span className="mb-1 ml-6 inline-flex">
              <Spinner size={32} />
            </span>
          )}
        </div>
        <FocusBlock focusKey="b-filters" onEnter={() => scroll(0)} preferredChildFocusKey="b-sort" className="flex items-start">
          <div className="shrink-0 pr-6 pt-6" style={{ width: SORT_W }}>
            <FocusButton
              focusKey="b-sort"
              onPress={cycleSort}
              className={`tv-chip truncate bg-surface-2 px-8 py-5 text-center text-2xl font-semibold ${design === "terminal" ? "t-label" : "rounded-control"}`}
            >
              ⇅ {t(`catalog.sort.${sort}`)}
            </FocusButton>
          </div>
          {genres.data && (
            <HRow
              focusKey="b-genres"
              items={chips}
              itemKey={(c) => cardKey("genre", c.id ?? "all")}
              itemWidth={260}
              itemHeight={76}
              gap={16}
              viewport={width - SORT_W}
              initialIndex={Math.max(0, chips.findIndex((c) => c.id === genre))}
              onSelect={(c) => pickGenre(c.id)}
              renderItem={(c, focused) => (
                <div
                  className={`tv-focus tv-chip flex h-[76px] items-center justify-center px-6 text-2xl font-semibold ${design === "terminal" ? "t-label text-[20px]" : "rounded-control"} ${
                    focused ? "is-focused" : c.id === genre ? "bg-accent text-on-accent" : "bg-surface-2 text-text"
                  }`}
                >
                  <span className="truncate">{c.name}</span>
                </div>
              )}
            />
          )}
        </FocusBlock>
        <div className="absolute left-0 right-0" style={{ top: GRID_TOP }}>
          {grid}
        </div>
      </FocusLine>
    </div>
  );
}

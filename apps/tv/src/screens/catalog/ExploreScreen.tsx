import { useState, type ReactNode } from "react";
import type { MediaSummary } from "@martytv/contracts";
import { imageUrl, placeholderColor } from "@martytv/media-types";
import { Spinner, useI18n } from "@martytv/ui";
import { FocusLine, useInitialFocus } from "../../focus";
import { cardKey } from "../../catalog/focusKeys";
import type { RouteMemory } from "../../catalog/nav";
import { isUnavailable, useCatalogConfig } from "../../catalog/queries";
import { nearEnd } from "../../catalog/virtual";
import { HRow } from "../../components/HRow";
import { Img, legacyColor } from "../../components/Img";
import { VGrid } from "../../components/VGrid";
import { ErrorState, GridSkeleton, RowSkeleton } from "../../components/States";
import { useDesign, useFrame, useSkin, type Design } from "../../design/context";
import { GridCard, gridGeo, ScreenTitle } from "../../design/grid";
import { indexTag } from "../../design/format";
import { useReportDeep, useToTop } from "../../design/topJump";
import { useCollection, useExplore, useTileBrowse, type ExploreSection, type ExploreTile } from "../../foryou/queries";
import { REGEN_TILE, useRegenerate, useRegenStatus, withRegenTile } from "../../foryou/regen";
import { waveTileGlyph } from "../../design/waveIcons";

const EDGE = 40;
const ROWS_TOP = 150;
const TILE = { w: 340, h: 190 };
const HEADER = 62;
const PAD = 24;
const ROW_H = HEADER + TILE.h + 2 * PAD + 10;

/** «Обзор»: Explore sections as rows of tiles. */
export function ExploreScreen({ mem, onTile }: { mem: RouteMemory; onTile: (tile: ExploreTile) => void }) {
  const { t, locale } = useI18n();
  const design = useDesign();
  const frame = useFrame();
  const cfg = useCatalogConfig();
  const q = useExplore();
  const regen = useRegenStatus();
  const doRegen = useRegenerate();
  const loaded = (q.data?.sections ?? []).filter((s) => s.tiles.length > 0);
  // «Обновить подборки ИИ»: an action tile first in «Подборки дня» (AI on).
  const rs = regen.data;
  const sections =
    rs?.ai_enabled && q.data
      ? withRegenTile(
          loaded,
          {
            title: rs.running ? t("taste.regen.running") : t("taste.regen"),
            subtitle: rs.running
              ? null
              : rs.available
                ? rs.unlimited
                  ? t("taste.regen.hint_unlimited")
                  : t("taste.regen.hint")
                : t("taste.regen.tv_used", { time: new Date(rs.next_available_at).toLocaleTimeString(locale === "en" ? "en-GB" : locale === "kk" ? "kk-KZ" : "ru-RU", { hour: "2-digit", minute: "2-digit" }) }),
          },
          t("taste.regen.section"),
        )
      : loaded;
  const [ri, setRi] = useState(() => mem.get<number>("row") ?? 0);
  const r = Math.min(ri, Math.max(0, sections.length - 1));
  const viewport = 1920 - frame.x - 40;
  const keys = sections.map((s) => `x-${s.id}`);
  const first = sections[0];
  useInitialFocus(!q.isPending, mem, () => (first ? cardKey(`x-${first.id}`, first.tiles[0]!.id) : q.isError ? "x-retry" : undefined));

  const setRow = (v: number) => {
    setRi(v);
    mem.set("row", v);
  };
  useToTop(() => {
    setRow(0);
    return false;
  });
  const ty = r === 0 ? 0 : ROWS_TOP + r * ROW_H - 40;
  useReportDeep(ty > 0);

  let body: ReactNode;
  if (q.isPending) body = <RowSkeleton count={5} width={TILE.w} height={TILE.h} />;
  else if (q.isError) body = <ErrorState focusKey="x-retry" error={q.error} unavailable={isUnavailable(q.error, cfg.data)} onRetry={() => void q.refetch()} />;
  else if (!sections.length) body = <p className="text-[30px] text-muted">{t("fy.explore.empty")}</p>;
  else
    body = (
      <FocusLine focusKey="x-rows" keys={keys} preferred={keys[r]} className="relative">
        {sections.map((s, i) =>
          Math.abs(i - r) > 3 ? null : (
            <section key={s.id} data-section={s.id} className="absolute left-0 w-full" style={{ top: i * ROW_H }}>
              <SectionHeader design={design} index={i + 1} title={s.title} current={i === r} />
              <div style={{ marginTop: -PAD + 6 }}>
                <HRow
                  focusKey={`x-${s.id}`}
                  items={s.tiles}
                  itemKey={(tile) => cardKey(`x-${s.id}`, tile.id)}
                  itemWidth={TILE.w}
                  itemHeight={TILE.h}
                  gap={design === "terminal" ? 18 : 26}
                  pad={PAD}
                  viewport={viewport}
                  initialIndex={mem.get<number>(`idx-${s.id}`) ?? 0}
                  onIndexChange={(j) => {
                    setRow(i);
                    mem.set(`idx-${s.id}`, j);
                  }}
                  onSelect={(tile) => {
                    if (tile.id !== REGEN_TILE) return onTile(tile);
                    if (rs?.available && !doRegen.isPending) doRegen.mutate();
                  }}
                  renderItem={(tile, focused) => <Tile tile={tile} section={s} focused={focused} design={design} cfg={cfg.data} />}
                />
              </div>
            </section>
          ),
        )}
      </FocusLine>
    );

  return (
    <div data-testid="explore" className="absolute overflow-hidden" style={{ left: frame.x - EDGE, right: 0, top: frame.top, bottom: 1080 - frame.bottom }}>
      <div className="tv-track absolute right-0 top-0" style={{ left: EDGE, transform: `translate3d(0,${-ty}px,0)` }}>
        <div className="flex h-[136px] items-end pb-6">
          <ScreenTitle design={design} index={4}>
            {t("fy.explore.title")}
          </ScreenTitle>
          <span className="mb-2 ml-6 truncate text-[24px] text-muted">{t("fy.explore.subtitle")}</span>
        </div>
        <div className="absolute left-0 right-0" style={{ top: ROWS_TOP }}>
          {body}
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ design, index, title, current }: { design: Design; index: number; title: string; current: boolean }) {
  if (design === "terminal") {
    return (
      <div className="flex items-center" style={{ height: HEADER }}>
        <h3 className={`t-label whitespace-nowrap text-[25px] ${current ? "text-text" : "text-muted"}`}>
          {indexTag(index)} / {title}
        </h3>
        <span className="t-hair ml-6 w-[300px] border-t" />
      </div>
    );
  }
  return (
    <div className="flex items-center" style={{ height: HEADER }}>
      <h3 className={`truncate text-[31px] font-bold ${current || design === "projector" ? "text-text" : "text-text/70"}`}>{title}</h3>
    </div>
  );
}

function Tile({ tile, section, focused, design, cfg }: { tile: ExploreTile; section: ExploreSection; focused: boolean; design: Design; cfg: Parameters<typeof imageUrl>[0] }) {
  const { t } = useI18n();
  const img = imageUrl(cfg, tile.image_path, "w780");
  const ai = tile.kind === "collection" && tile.id !== REGEN_TILE;
  const square = design === "terminal";
  // «Каркас»: every tile gets a neon line icon (emoji, genre or kind).
  const wave = useSkin() === "wireframe";
  return (
    <div
      data-tile={tile.id}
      data-regen-state={tile.id === REGEN_TILE ? (tile.subtitle ? "idle" : "running") : undefined}
      className={`tv-focus relative overflow-hidden ${square ? "" : "rounded-card"} ${focused ? "is-focused" : ""}`}
      style={{ width: TILE.w, height: TILE.h, background: legacyColor(placeholderColor(`${section.id}${tile.id}`)) }}
    >
      <Img src={img} className="absolute left-0 top-0 h-full w-full object-cover" />
      {img && <div className="p-card-shade absolute left-0 top-0 h-full w-full" />}
      {wave ? (
        <span className="w-glyph absolute left-5 top-4 inline-flex leading-none">{waveTileGlyph(tile, 58)}</span>
      ) : (
        tile.emoji && <span className="absolute left-5 top-3 text-[56px] leading-none">{tile.emoji}</span>
      )}
      {ai && <span className="tv-check absolute right-3 top-3 rounded-full px-3 py-[2px] text-[17px] font-bold">{t("fy.collection.badge")}</span>}
      {/* «Подборки»: watched / count of the list. */}
      {tile.kind === "curated" && tile.progress && (
        <span data-progress-label className="tv-check absolute right-3 top-3 rounded-full px-3 py-[2px] text-[19px] font-bold">
          {tile.progress}
        </span>
      )}
      <div className="absolute bottom-4 left-5 right-5">
        <p className={`line-clamp-2 text-[28px] font-bold leading-tight text-white ${square ? "t-label text-[24px]" : ""}`}>{tile.title}</p>
        {tile.subtitle && <p className="mt-1 truncate text-[19px] text-white/75">{tile.subtitle}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tile / collection grids

const GRID_TOP = 160;
const ROW_TOP = 110;
/** Pinned header: room above the clipped grid for the focus frame / glow. */
const CLIP_PAD = 48;

/** A poster grid under a header; scrolls by grid row like «Моё». */
export function TitleGrid({
  testId,
  scope,
  header,
  headerHeight = GRID_TOP,
  items,
  pending,
  error,
  onRetry,
  onNearEnd,
  mem,
  from,
  onOpen,
  onFocusIndex,
  pinHeader = false,
}: {
  testId: string;
  scope: string;
  header: ReactNode;
  headerHeight?: number;
  items: MediaSummary[];
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  onNearEnd?: () => void;
  mem: RouteMemory;
  from: string;
  onOpen: (item: MediaSummary, from?: string) => void;
  /** The focused card's index (curated lists show its note in the header). */
  onFocusIndex?: (i: number) => void;
  /** The header stays put and only the grid scrolls under it (it shows the focused card's note). */
  pinHeader?: boolean;
}) {
  const { t } = useI18n();
  const design = useDesign();
  const frame = useFrame();
  const cfg = useCatalogConfig();
  const g = gridGeo(design, 1920 - frame.x - 72);
  const [ty, setTy] = useState(() => mem.get<number>("ty") ?? 0);
  useInitialFocus(!pending, mem, () => (items[0] ? cardKey(scope, items[0].id) : error ? `${scope}-retry` : undefined));
  useToTop(() => {
    setTy(0);
    mem.set("ty", 0);
    return false;
  });
  useReportDeep(ty > 0);

  let body: ReactNode;
  if (pending) body = <GridSkeleton cols={g.cols} width={g.w} height={g.h} pitchX={g.pitchX} pitchY={g.pitchY} />;
  else if (error) body = <ErrorState focusKey={`${scope}-retry`} error={error} onRetry={onRetry} />;
  else if (!items.length) body = <p className="text-[30px] text-muted">{t("fy.browse.empty")}</p>;
  else
    body = (
      <VGrid
        focusKey={`${scope}-grid`}
        items={items}
        itemKey={(it) => cardKey(scope, it.id)}
        cols={g.cols}
        itemWidth={g.w}
        pitchX={g.pitchX}
        pitchY={g.pitchY}
        initialIndex={mem.get<number>("idx") ?? 0}
        onIndexChange={(i) => {
          mem.set("idx", i);
          onFocusIndex?.(i);
          const row = Math.floor(i / g.cols);
          const v = pinHeader ? row * g.pitchY : row === 0 ? 0 : headerHeight + row * g.pitchY - ROW_TOP;
          setTy(v);
          mem.set("ty", v);
          if (onNearEnd && nearEnd(i, items.length, g.cols * 3)) onNearEnd();
        }}
        onSelect={(it) => onOpen(it, from)}
        quick={(it) => ({ item: it, onOpen: () => onOpen(it, from) })}
        renderItem={(it, focused, i) => <GridCard item={it} cfg={cfg.data} g={g} focused={focused} index={i} />}
      />
    );
  const keys = items.length ? [`${scope}-grid`] : [`${scope}-retry`];
  if (pinHeader)
    return (
      <div data-testid={testId} className="absolute overflow-hidden" style={{ left: frame.x - EDGE, right: 0, top: frame.top, bottom: 1080 - frame.bottom }}>
        <FocusLine focusKey={`${scope}-page`} keys={keys} className="absolute inset-0">
          <div className="absolute right-0 top-0" style={{ left: EDGE }}>
            {header}
          </div>
          <div className="absolute bottom-0 left-0 right-0 overflow-hidden" style={{ top: headerHeight - CLIP_PAD }}>
            <div className="tv-track absolute right-0" style={{ left: EDGE, top: CLIP_PAD, transform: `translate3d(0,${-ty}px,0)` }}>
              {body}
            </div>
          </div>
        </FocusLine>
      </div>
    );
  return (
    <div data-testid={testId} className="absolute overflow-hidden" style={{ left: frame.x - EDGE, right: 0, top: frame.top, bottom: 1080 - frame.bottom }}>
      <FocusLine focusKey={`${scope}-page`} keys={keys} className="tv-track absolute right-0 top-0" style={{ left: EDGE, transform: `translate3d(0,${-ty}px,0)` }}>
        {header}
        <div className="absolute left-0 right-0" style={{ top: headerHeight }}>
          {body}
        </div>
      </FocusLine>
    </div>
  );
}

/** An Explore tile's titles (mood, decade, country, genre, keyword). */
export function TileScreen({ tile, title, mem, onOpen }: { tile: string; title: string; mem: RouteMemory; onOpen: (item: MediaSummary, from?: string) => void }) {
  const { t } = useI18n();
  const design = useDesign();
  const q = useTileBrowse(tile);
  const name = q.title ?? title;
  return (
    <TitleGrid
      testId="explore-tile"
      scope="xt"
      mem={mem}
      from={name}
      onOpen={onOpen}
      items={q.items}
      pending={q.isPending}
      error={q.isError ? q.error : null}
      onRetry={() => void q.refetch()}
      onNearEnd={() => q.hasNextPage && !q.isFetchingNextPage && void q.fetchNextPage()}
      header={
        <div className="flex h-[136px] items-end pb-6">
          <ScreenTitle design={design}>{name}</ScreenTitle>
          {q.total > 0 && <span className="mb-1 ml-6 text-2xl text-muted">{t("catalog.tv.results", { n: q.total })}</span>}
          {q.isFetchingNextPage && (
            <span className="mb-1 ml-6 inline-flex">
              <Spinner size={32} />
            </span>
          )}
        </div>
      }
    />
  );
}

/** An AI collection: «Подборка дня» badge, title, description and its titles. */
export function CollectionScreen({ id, title, mem, onOpen }: { id: string; title?: string; mem: RouteMemory; onOpen: (item: MediaSummary, from?: string) => void }) {
  const { t } = useI18n();
  const design = useDesign();
  const q = useCollection(id);
  const c = q.data;
  const name = c?.title ?? title ?? "";
  const notFound = q.isError;
  return (
    <TitleGrid
      testId="collection"
      scope="xc"
      mem={mem}
      from={name}
      onOpen={onOpen}
      items={c?.items ?? []}
      pending={q.isPending}
      error={notFound ? q.error : null}
      onRetry={() => void q.refetch()}
      headerHeight={300}
      header={
        <div className="pt-10" style={{ height: 300 }}>
          <span className={`inline-block px-4 py-1 text-[20px] font-bold ${design === "terminal" ? "t-label bg-accent text-on-accent" : "rounded-full bg-accent text-on-accent"}`}>
            ✦ {t("fy.collection.badge")}
            {c ? ` · ${c.scope === "profile" ? t("fy.collection.personal") : t("fy.collection.global")}` : ""}
          </span>
          <div className="mt-4">
            <ScreenTitle design={design}>{name}</ScreenTitle>
          </div>
          {c?.description && <p className="mt-3 line-clamp-2 max-w-[1400px] text-[26px] leading-snug text-text/75">{c.description}</p>}
          {notFound && <p className="mt-3 text-[26px] text-muted">{t("fy.collection.not_found")}</p>}
        </div>
      }
    />
  );
}


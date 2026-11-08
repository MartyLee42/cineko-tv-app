import { lazy, Suspense, useState } from "react";
import type { MediaSummary } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";
import { isSticker } from "@martytv/ui/keepsakes/logic";
import { FocusButton, FocusLine, useInitialFocus } from "../../focus";
import { cardKey } from "../../catalog/focusKeys";
import type { RouteMemory } from "../../catalog/nav";
import { useCatalogConfig } from "../../catalog/queries";
import { VGrid } from "../../components/VGrid";
import { ErrorState, GridSkeleton } from "../../components/States";
import { useDesign, useFrame } from "../../design/context";
import { useWatchlist } from "../../design/data";
import { GridCard, gridGeo, ScreenTitle } from "../../design/grid";
import { useReportDeep, useToTop } from "../../design/topJump";
import { keepHeight, useTvAchievements, useTvTickets } from "../../keepsakes/data";
import { retrying } from "../../retry";

// Ticket stubs + stickers: their own chunk (the shared art and its CSS).
const loadRail = retrying(() => import("../../keepsakes/TicketRail"));
const TicketRail = lazy(() => loadRail().then((m) => ({ default: m.TicketRail })));

/** Room left of the text column so focus frames / brackets aren't clipped. */
const EDGE = 40;
/** Where a scrolled-to grid row lands (below the top chrome and the frame). */
const ROW_TOP = 110;
const GRID_TOP = 150;

/** «Моё»: the profile's ticket stubs and stickers, then its watchlist as a poster grid. */
export function MineScreen({ mem, onOpen, onHome }: { mem: RouteMemory; onOpen: (item: MediaSummary, from?: string) => void; onHome: () => void }) {
  const { t } = useI18n();
  const design = useDesign();
  const frame = useFrame();
  const cfg = useCatalogConfig();
  const list = useWatchlist();
  const tickets = useTvTickets();
  const ach = useTvAchievements();
  const items = list.data?.items ?? [];
  const width = 1920 - frame.x - 72;
  const g = gridGeo(design, width);
  const [ty, setTy] = useState(() => mem.get<number>("ty") ?? 0);
  const firstTicket = tickets.data?.items[0];
  const hasStickers = !!ach.data?.items.some((a) => isSticker(a.id));
  const keepH = keepHeight(!!firstTicket, hasStickers);
  const gridTop = GRID_TOP + keepH;
  // Keepsakes that fail to load just stay hidden; wait for them so the grid doesn't jump.
  const ready = !list.isPending && !tickets.isLoading && !ach.isLoading;
  // Never park focus in the menu: an empty list focuses its own «Home» button.
  useInitialFocus(ready, mem, () =>
    firstTicket ? `mt-${firstTicket.number}` : items[0] ? cardKey("m", items[0].id) : list.isError ? "mine-retry" : "mine-home",
  );

  useToTop(() => {
    setTy(0);
    mem.set("ty", 0);
    return false;
  });
  useReportDeep(ty > 0);

  let body: React.ReactNode;
  if (!ready) body = <GridSkeleton cols={g.cols} width={g.w} height={g.h} pitchX={g.pitchX} pitchY={g.pitchY} />;
  else if (list.isError) body = <ErrorState focusKey="mine-retry" error={list.error} onRetry={() => void list.refetch()} />;
  else if (items.length === 0)
    body = (
      <div data-testid="mine-empty">
        <p className="max-w-[1100px] text-[30px] leading-snug text-muted">{t("tvd.mine.empty")}</p>
        <div className="mt-10 flex">
          <FocusButton focusKey="mine-home" onPress={onHome} className="rounded-control bg-surface-2 px-10 py-5 text-[28px] font-bold">
            {t("nav.home")}
          </FocusButton>
        </div>
      </div>
    );
  else
    body = (
      <VGrid
        focusKey="m-grid"
        items={items}
        itemKey={(it) => cardKey("m", it.id)}
        cols={g.cols}
        itemWidth={g.w}
        pitchX={g.pitchX}
        pitchY={g.pitchY}
        initialIndex={mem.get<number>("idx") ?? 0}
        onIndexChange={(i) => {
          mem.set("idx", i);
          const row = Math.floor(i / g.cols);
          const v = row === 0 && keepH === 0 ? 0 : gridTop + row * g.pitchY - ROW_TOP;
          setTy(v);
          mem.set("ty", v);
        }}
        onSelect={(it) => onOpen(it, t("tvd.mine.title"))}
        quick={(it) => ({ item: it, onOpen: () => onOpen(it, t("tvd.mine.title")) })}
        renderItem={(it, focused, i) => <GridCard item={it} cfg={cfg.data} g={g} focused={focused} index={i} />}
      />
    );

  const lineKeys = [...(firstTicket ? ["m-tickets"] : []), items.length > 0 ? "m-grid" : list.isError ? "mine-retry" : "mine-home"];
  return (
    <div data-testid="mine" className="absolute overflow-hidden" style={{ left: frame.x - EDGE, right: 0, top: frame.top, bottom: 1080 - frame.bottom }}>
      <FocusLine focusKey="m-page" keys={lineKeys} className="tv-track absolute right-0 top-0" style={{ left: EDGE, transform: `translate3d(0,${-ty}px,0)` }}>
        <div className="flex h-[136px] items-end pb-6">
          <ScreenTitle design={design} index={5}>
            {t("tvd.mine.title")}
          </ScreenTitle>
          {list.data && list.data.total_results > 0 && <span className="mb-1 ml-6 text-2xl text-muted">{t("catalog.tv.results", { n: list.data.total_results })}</span>}
        </div>
        {ready && keepH > 0 && (
          <div className="absolute left-0 right-0" style={{ top: GRID_TOP - 10 }}>
            <Suspense fallback={null}>
              <TicketRail
                page={tickets.data}
                achievements={ach.data}
                viewport={width}
                initialIndex={mem.get<number>("tidx") ?? 0}
                onIndexChange={(i) => {
                  mem.set("tidx", i);
                  setTy(0);
                  mem.set("ty", 0);
                }}
                onOpen={(m) => onOpen(m, t("tvd.mine.title"))}
              />
            </Suspense>
          </div>
        )}
        <div className="absolute left-0 right-0" style={{ top: gridTop }}>
          {body}
        </div>
      </FocusLine>
    </div>
  );
}

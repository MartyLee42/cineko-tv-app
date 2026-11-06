import { useState } from "react";
import type { MediaSummary } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";
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

/** Room left of the text column so focus frames / brackets aren't clipped. */
const EDGE = 40;
/** Where a scrolled-to grid row lands (below the top chrome and the frame). */
const ROW_TOP = 110;
const GRID_TOP = 150;

/** «Моё»: the profile's watchlist as a poster grid. */
export function MineScreen({ mem, onOpen, onHome }: { mem: RouteMemory; onOpen: (item: MediaSummary, from?: string) => void; onHome: () => void }) {
  const { t } = useI18n();
  const design = useDesign();
  const frame = useFrame();
  const cfg = useCatalogConfig();
  const list = useWatchlist();
  const items = list.data?.items ?? [];
  const g = gridGeo(design, 1920 - frame.x - 72);
  const [ty, setTy] = useState(() => mem.get<number>("ty") ?? 0);
  // Never park focus in the menu: an empty list focuses its own «Home» button.
  useInitialFocus(!list.isPending, mem, () => (items[0] ? cardKey("m", items[0].id) : list.isError ? "mine-retry" : "mine-home"));

  useToTop(() => {
    setTy(0);
    mem.set("ty", 0);
    return false;
  });
  useReportDeep(ty > 0);

  let body: React.ReactNode;
  if (list.isPending) body = <GridSkeleton cols={g.cols} width={g.w} height={g.h} pitchX={g.pitchX} pitchY={g.pitchY} />;
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
          const v = row === 0 ? 0 : GRID_TOP + row * g.pitchY - ROW_TOP;
          setTy(v);
          mem.set("ty", v);
        }}
        onSelect={(it) => onOpen(it, t("tvd.mine.title"))}
        renderItem={(it, focused, i) => <GridCard item={it} cfg={cfg.data} g={g} focused={focused} index={i} />}
      />
    );

  return (
    <div data-testid="mine" className="absolute overflow-hidden" style={{ left: frame.x - EDGE, right: 0, top: frame.top, bottom: 1080 - frame.bottom }}>
      <FocusLine focusKey="m-page" keys={items.length > 0 ? ["m-grid"] : ["mine-home"]} className="tv-track absolute right-0 top-0" style={{ left: EDGE, transform: `translate3d(0,${-ty}px,0)` }}>
        <div className="flex h-[136px] items-end pb-6">
          <ScreenTitle design={design} index={5}>
            {t("tvd.mine.title")}
          </ScreenTitle>
          {list.data && list.data.total_results > 0 && <span className="mb-1 ml-6 text-2xl text-muted">{t("catalog.tv.results", { n: list.data.total_results })}</span>}
        </div>
        <div className="absolute left-0 right-0" style={{ top: GRID_TOP }}>
          {body}
        </div>
      </FocusLine>
    </div>
  );
}

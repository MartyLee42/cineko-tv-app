// A YouTube channel: avatar, name, subscribers, «Подписаться» / «Вы
// подписаны» and its uploads (OK plays, holding OK = the video menu); more
// uploads load as focus nears the end. A failed page keeps the grid and
// focus, says so under it and retries by itself.
import { useEffect, useMemo, useState } from "react";
import { Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { FocusBlock, FocusButton, FocusLine, getCurrentFocusKey, useInitialFocus } from "../../focus";
import { cardKey } from "../../catalog/focusKeys";
import type { RouteMemory } from "../../catalog/nav";
import { VGrid } from "../../components/VGrid";
import { Img } from "../../components/Img";
import { ErrorState, GridSkeleton } from "../../components/States";
import { useDesign, useFrame } from "../../design/context";
import { ScreenTitle } from "../../design/grid";
import { useReportDeep, useToTop } from "../../design/topJump";
import { compactCount, countForm, dedupeById, wantsMore, type VideoItem } from "../../video/logic";
import { isVideoUnavailable, setSubscribed, useAutoRetry, useVideoChannel } from "../../video/queries";
import { useVideoMenu } from "../../video/actions";
import { VideoCard, videoGeo } from "../../video/VideoCard";
import { prefetchGrid } from "../../video/prefetch";
import { Unavailable } from "./VideoScreen";

const EDGE = 40;
const GRID_TOP = 250;

export function VideoChannelScreen({
  id,
  name,
  mem,
  onPlay,
}: {
  id: string;
  name: string;
  mem: RouteMemory;
  onPlay: (v: VideoItem, start: number | null) => void;
}) {
  const { t, locale } = useI18n();
  const design = useDesign();
  const frame = useFrame();
  const g = videoGeo(design);
  const width = 1920 - frame.x - 72;
  const cols = Math.max(2, Math.floor((width + g.gap) / (g.w + g.gap)));
  const pitchX = g.w + g.gap;
  const pitchY = g.h + g.caption + 26;
  const q = useVideoChannel(id);
  const ch = q.data?.pages[0]?.channel ?? undefined;
  const items = useMemo(() => dedupeById(q.data?.pages.flatMap((p) => p.items) ?? []), [q.data]);
  const moreFailed = q.isFetchNextPageError;
  /** Nothing loaded (the first page failed): the only case for the full error. */
  const fullError = q.isError && items.length === 0;
  useAutoRetry(q.isError, () => void (moreFailed ? q.fetchNextPage() : q.refetch()));
  const more = (i: number) => {
    if (wantsMore(i, items.length, { hasNext: !!q.hasNextPage, fetching: q.isFetching, failed: moreFailed }, cols * 2)) void q.fetchNextPage();
  };
  useEffect(() => {
    if (getCurrentFocusKey()?.startsWith("vc-")) more(mem.get<number>("idx") ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, q.isFetching]);
  const [subscribed, setSub] = useState<boolean | null>(null);
  const isSub = subscribed ?? ch?.subscribed ?? false;
  const [ty, setTy] = useState(() => mem.get<number>("ty") ?? 0);
  const menu = useVideoMenu({ onPlay });

  useInitialFocus(!q.isPending, mem, () => (items[0] ? cardKey("vc", items[0].id) : "vc-sub"));
  const scroll = (v: number) => {
    setTy(v);
    mem.set("ty", v);
  };
  useToTop(() => {
    scroll(0);
    return false;
  });
  useReportDeep(ty > 0);

  const toggle = () => {
    const next = !isSub;
    setSub(next);
    void setSubscribed(id, next).catch(() => setSub(!next));
  };

  let grid: React.ReactNode;
  if (fullError && isVideoUnavailable(q.error)) grid = <Unavailable autoFocus={false} onRetry={() => void q.refetch()} />;
  else if (fullError) grid = <ErrorState focusKey="vc-retry" autoFocus={false} error={q.error} onRetry={() => void q.refetch()} />;
  else if (q.isPending) grid = <GridSkeleton cols={cols} width={g.w} height={g.h} pitchX={pitchX} pitchY={pitchY} />;
  else if (items.length === 0) grid = <p className="text-3xl text-muted">{t("video.empty.search")}</p>;
  else
    grid = (
      <VGrid
        focusKey="vc-grid"
        items={items}
        itemKey={(v) => cardKey("vc", v.id)}
        cols={cols}
        itemWidth={g.w}
        pitchX={pitchX}
        pitchY={pitchY}
        initialIndex={mem.get<number>("idx") ?? 0}
        onIndexChange={(i) => {
          mem.set("idx", i);
          const row = Math.floor(i / cols);
          scroll(row === 0 ? 0 : GRID_TOP + row * pitchY - 110);
          more(i);
          prefetchGrid(items, i, cols, g.w);
        }}
        onSelect={(v) => menu.select(v)}
        onLongPress={(v) => menu.more(v)}
        renderItem={(v, focused, i) => <VideoCard v={v} focused={focused} g={g} index={i + 1} />}
      />
    );
  const footer =
    items.length > 0 && (q.isFetchingNextPage || moreFailed) ? (
      <p data-testid="video-more" data-failed={moreFailed ? "1" : "0"} className="flex items-center text-[24px] text-muted" style={{ height: 80 }}>
        {q.isFetchingNextPage && <Spinner size={30} />}
        <span className="ml-4">{q.isFetchingNextPage ? t("video.tv.loading_more") : t("video.tv.more_failed")}</span>
      </p>
    ) : null;

  const subs = ch?.subscribers;
  return (
    <div data-testid="video-channel" className="absolute overflow-hidden" style={{ left: frame.x - EDGE, right: 0, top: frame.top, bottom: 1080 - frame.bottom }}>
      <FocusLine focusKey="vc-page" keys={items.length > 0 ? ["vc-head", "vc-grid"] : fullError ? ["vc-head", "vc-error"] : ["vc-head"]} className="tv-track absolute right-0 top-0" style={{ left: EDGE, transform: `translate3d(0,${-ty}px,0)` }}>
        <div className="flex h-[200px] items-center pt-8">
          <span className="relative mr-8 inline-block h-[120px] w-[120px] shrink-0 overflow-hidden rounded-full bg-surface-2">
            <span className="absolute left-0 top-0 flex h-full w-full items-center justify-center text-[52px] font-bold text-muted">{name.charAt(0).toUpperCase()}</span>
            <Img src={ch?.avatar} className="absolute left-0 top-0 h-full w-full object-cover" />
          </span>
          <div className="min-w-0">
            <ScreenTitle design={design}>
              {ch?.name ?? name}
              {ch?.verified ? " ✓" : ""}
            </ScreenTitle>
            {subs !== null && subs !== undefined && (
              <p className="mt-2 text-[26px] text-muted">{t(`video.tv.subs.${countForm(subs, locale)}` as MessageKey, { n: compactCount(subs, locale) })}</p>
            )}
          </div>
          <FocusBlock focusKey="vc-head" onEnter={() => scroll(0)} className="ml-12 flex">
            <FocusButton
              focusKey="vc-sub"
              onPress={toggle}
              className={`tv-chip flex h-[72px] items-center px-9 text-[26px] font-semibold ${design === "terminal" ? "t-label text-[20px]" : "rounded-full"} ${isSub ? "bg-surface-2 text-text" : "bg-accent text-on-accent"}`}
            >
              <span data-testid="video-subscribe" data-subscribed={isSub ? "1" : "0"}>
                {isSub ? `✓ ${t("video.subscribed")}` : t("video.subscribe")}
              </span>
            </FocusButton>
          </FocusBlock>
          {q.isFetching && !q.isPending && (
            <span className="ml-6 inline-flex">
              <Spinner size={28} />
            </span>
          )}
        </div>
        <div className="absolute left-0 right-0" style={{ top: GRID_TOP }}>
          {fullError ? <FocusBlock focusKey="vc-error">{grid}</FocusBlock> : grid}
          {footer}
        </div>
      </FocusLine>
      {menu.node}
    </div>
  );
}

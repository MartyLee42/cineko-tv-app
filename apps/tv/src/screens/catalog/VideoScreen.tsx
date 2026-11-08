// «Видео» (YouTube via the self-hosted Invidious): rows Продолжить, Подписки,
// В тренде, Смотреть позже, История, and a «Поиск» button. OK plays (an
// unfinished video asks where to start); holding OK (or ☰) offers watch
// later, the channel and removing from history. «Подписки» loads more as
// focus nears its end.
//
// Errors never move focus: a failed (re)load keeps the rows that are there
// (React Query keeps their data), says so in a line by the title and retries
// by itself with a growing pause; «Повторить» sits next to «Поиск» (reached
// with ▲, never focused for you). Only when nothing at all could be loaded
// does the page show a full error — at the top, whatever the scroll was.
// (Before, any 503 — e.g. a background refetch of «В тренде» while the VPN
// was down — swapped every row for a full-screen block with an auto-focused
// «Повторить»: the focused card vanished and the block sat above the
// remembered scroll position, so the page looked scrolled past its end.)
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { FocusBlock, FocusButton, FocusLine, getCurrentFocusKey, useInitialFocus } from "../../focus";
import { cardKey } from "../../catalog/focusKeys";
import type { RouteMemory } from "../../catalog/nav";
import { HRow, ROW_PAD } from "../../components/HRow";
import { ErrorState, RowSkeleton } from "../../components/States";
import { useDesign, useFrame, useSkin, type Design } from "../../design/context";
import { VoiceOfAmerica } from "../../design/cvCards";
import { ScreenTitle } from "../../design/grid";
import { SearchIcon } from "../../design/icons";
import { indexTag } from "../../design/format";
import { TERMINAL_MENU } from "../../design/menuOrder";
import { useReportDeep, useToTop } from "../../design/topJump";
import { dedupeById, fullTabError, tabRows, wantsMore, withoutIds, type RowId, type VideoItem } from "../../video/logic";
import { isVideoUnavailable, useAutoRetry, useVideoContinue, useVideoFeed, useVideoHistory, useVideoTrending, useVideoWatchLater } from "../../video/queries";
import { useVideoMenu } from "../../video/actions";
import { VideoCard, videoGeo } from "../../video/VideoCard";
import { prefetchAround, thumbPrefetch } from "../../video/prefetch";

const EDGE = 40;
/** Title line + the «Поиск» button. */
const ROWS_TOP = 236;
const ROW_HEAD = 58;
const EMPTY_H = 120;

const ROW_TITLE: Record<RowId, MessageKey> = {
  continue: "video.continue",
  subscriptions: "video.subscriptions",
  trending: "video.trending",
  watch_later: "video.watch_later",
  history: "video.history",
};

export function VideoScreen({
  mem,
  onPlay,
  onSearch,
  onChannel,
}: {
  mem: RouteMemory;
  onPlay: (v: VideoItem, start: number | null) => void;
  onSearch: () => void;
  onChannel: (channelId: string, name: string) => void;
}) {
  const { t } = useI18n();
  const design = useDesign();
  const cv = useSkin() === "constructivism";
  const frame = useFrame();
  const g = videoGeo(design);
  const viewport = 1920 - frame.x - 48;
  const cont = useVideoContinue();
  const feed = useVideoFeed();
  const trending = useVideoTrending();
  const later = useVideoWatchLater();
  const history = useVideoHistory();

  const data = useMemo(() => {
    const c = cont.data ?? [];
    const ids = new Set(c.map((v) => v.id));
    return {
      continue: c,
      subscriptions: feed.data ? withoutIds(dedupeById(feed.data.pages.flatMap((p) => p.items)), ids) : undefined,
      trending: trending.data ? withoutIds(trending.data, ids) : undefined,
      watch_later: later.data,
      history: history.data,
    } satisfies Record<RowId, readonly VideoItem[] | undefined>;
  }, [cont.data, feed.data, trending.data, later.data, history.data]);
  const lists: Record<RowId, { isError: boolean; isFetching: boolean; error: unknown; refetch: () => unknown }> = { continue: cont, subscriptions: feed, trending, watch_later: later, history };
  const queries = Object.values(lists);
  const pending = trending.isPending && feed.isPending;
  const fetching = queries.some((q) => q.isFetching);
  const rows = tabRows(data);
  const focusable = rows.filter((r) => (data[r]?.length ?? 0) > 0);
  // A failed next page of «Подписки» is retried as a next page; everything else is refetched.
  const morePageFailed = feed.isFetchNextPageError;
  const failed = (Object.keys(lists) as RowId[]).filter((r) => lists[r].isError && !(r === "subscriptions" && morePageFailed));
  const anyFailed = failed.length > 0 || morePageFailed;
  const unavailable = queries.some((q) => q.isError && isVideoUnavailable(q.error));
  /** Nothing to show at all and the loads failed: the one case for a full error. */
  const fullError = fullTabError(pending, focusable.length, failed);
  const retryFailed = () => {
    for (const r of failed) void lists[r].refetch();
    if (morePageFailed) void feed.fetchNextPage();
  };
  useAutoRetry(anyFailed, retryFailed);

  const tops: number[] = [];
  let acc = 0;
  for (const r of rows) {
    tops.push(acc);
    acc += ROW_HEAD + ((data[r]?.length ?? 0) > 0 ? g.h + g.caption + ROW_PAD + 18 : EMPTY_H);
  }

  const [ty, setTy] = useState(() => mem.get<number>("ty") ?? 0);
  const scroll = (v: number) => {
    setTy(v);
    mem.set("ty", v);
  };
  // The full error is drawn at the top: forget the old scroll (adjusted during render when it appears).
  const [wasFull, setWasFull] = useState(fullError);
  if (wasFull !== fullError) {
    setWasFull(fullError);
    if (fullError && ty !== 0) scroll(0);
  }
  const focusRow = (r: RowId) => {
    const i = rows.indexOf(r);
    mem.set("row", r);
    scroll(i <= 0 || r === focusable[0] ? 0 : ROWS_TOP + tops[i]! - 30);
  };
  useToTop(() => {
    scroll(0);
    return false;
  });
  useReportDeep(ty > 0);

  const menu = useVideoMenu({ onPlay, onChannel });

  const firstRow = focusable[0];
  useInitialFocus(!pending, mem, () => (firstRow ? cardKey(`v-${firstRow}`, data[firstRow]![0]!.id) : fullError ? "v-retry" : "v-search"));

  // «Подписки»: the next page once focus is close to the end (also when a page lands while it sits there).
  const subs = data.subscriptions ?? [];
  const moreFeed = (idx: number) => {
    if (wantsMore(idx, subs.length, { hasNext: !!feed.hasNextPage, fetching: feed.isFetching, failed: morePageFailed })) void feed.fetchNextPage();
  };
  useEffect(() => {
    if (getCurrentFocusKey()?.startsWith("v-subscriptions-")) moreFeed(mem.get<number>("idx-subscriptions") ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subs.length, feed.isFetching]);

  // Thumbnails ahead of focus: the row's next cards and the rows around it (also when a list lands).
  const prefetch = (r: RowId, idx: number) => {
    const i = focusable.indexOf(r);
    if (i < 0) return;
    prefetchAround(
      focusable.map((x) => data[x]!),
      i,
      idx,
      g.w,
      focusable.map((x) => mem.get<number>(`idx-${x}`) ?? 0),
    );
  };
  const focusableKey = focusable.map((r) => `${r}:${data[r]!.length}`).join();
  useEffect(() => {
    const r = (mem.get<RowId>("row") ?? focusable[0]) as RowId | undefined;
    if (r && focusable.includes(r)) prefetch(r, mem.get<number>(`idx-${r}`) ?? 0);
    else if (focusable[0]) prefetch(focusable[0], 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusableKey]);
  useEffect(() => () => thumbPrefetch.clear(), []);

  // ☰ / Tools / ContextMenu on a card: the same menu as holding OK.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (menu.open || !(e.key === "ContextMenu" || e.keyCode === 93 || e.keyCode === 10135)) return;
      const k = getCurrentFocusKey() ?? "";
      for (const r of focusable) {
        const v = data[r]!.find((x) => cardKey(`v-${r}`, x.id) === k);
        if (v) {
          e.preventDefault();
          menu.more(v, { inWatchLater: r === "watch_later", inHistory: r === "history" });
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  let body: ReactNode;
  if (pending) {
    body = <RowSkeleton count={5} width={g.w} height={g.h} />;
  } else if (fullError) {
    const err = (failed.includes("trending") ? trending : feed).error;
    body = (
      <FocusBlock focusKey="v-error">
        {isVideoUnavailable(err) ? <Unavailable title={false} autoFocus={false} onRetry={retryFailed} /> : <ErrorState focusKey="v-retry" autoFocus={false} error={err} onRetry={retryFailed} />}
      </FocusBlock>
    );
  } else {
    body = rows.map((r, i) => {
      const items = data[r] ?? [];
      const sub = r === "subscriptions";
      return (
        <section key={r} data-row={r} data-failed={lists[r].isError ? "1" : undefined} className="absolute left-0 w-full" style={{ top: tops[i] }}>
          <RowHeader design={design} index={i + 1} title={t(ROW_TITLE[r])} count={sub || r === "trending" ? null : items.length} />
          {items.length === 0 ? (
            <p data-testid={`video-empty-${r}`} className="max-w-[1300px] pt-2 text-[26px] leading-snug text-muted">
              {lists[r].isError ? t("video.tv.load_failed_auto") : sub ? t("video.empty.subscriptions") : t("video.tv.empty_trending")}
            </p>
          ) : (
            <div style={{ marginTop: -ROW_PAD + 6 }}>
              <HRow
                focusKey={`v-row-${r}`}
                items={items}
                itemKey={(v) => cardKey(`v-${r}`, v.id)}
                itemWidth={g.w}
                itemHeight={g.h + g.caption}
                gap={g.gap}
                viewport={viewport}
                initialIndex={mem.get<number>(`idx-${r}`) ?? 0}
                onIndexChange={(idx) => {
                  mem.set(`idx-${r}`, idx);
                  focusRow(r);
                  if (sub) moreFeed(idx);
                  prefetch(r, idx);
                }}
                onSelect={(v) => menu.select(v)}
                onLongPress={(v) => menu.more(v, { inWatchLater: r === "watch_later", inHistory: r === "history" })}
                renderItem={(v, focused, idx) => <VideoCard v={v} focused={focused} g={g} index={idx + 1} />}
                tail={sub ? <MoreTile g={g} loading={feed.isFetchingNextPage} failed={morePageFailed} /> : undefined}
              />
            </div>
          )}
        </section>
      );
    });
  }

  return (
    <div data-testid="video-tab" className="absolute overflow-hidden" style={{ left: frame.x - EDGE, right: 0, top: frame.top, bottom: 1080 - frame.bottom }}>
      <FocusLine
        focusKey="v-page"
        keys={fullError ? ["v-top", "v-error"] : ["v-top", ...focusable.map((r) => `v-row-${r}`)]}
        preferred={firstRow ? `v-row-${firstRow}` : "v-top"}
        className="tv-track absolute right-0 top-0"
        style={{ left: EDGE, transform: `translate3d(0,${fullError ? 0 : -ty}px,0)` }}
      >
        <div className="flex h-[136px] items-end pb-6">
          <ScreenTitle design={design} index={TERMINAL_MENU.indexOf("video") + 1}>
            {t("video.title")}
          </ScreenTitle>
          <span className="mb-1 ml-6 text-2xl text-muted">YouTube</span>
          {fetching && !pending && (
            <span className="mb-1 ml-6 inline-flex">
              <Spinner size={28} />
            </span>
          )}
        </div>
        {cv && <VoiceOfAmerica />}
        <FocusBlock focusKey="v-top" onEnter={() => scroll(0)} className="flex pt-2">
          <FocusButton
            focusKey="v-search"
            onPress={onSearch}
            className={`tv-chip flex h-[72px] items-center px-8 text-[26px] font-semibold ${design === "terminal" ? "t-label text-[20px]" : "rounded-control"} bg-surface-2 text-text`}
          >
            <SearchIcon size={30} stroke={2.2} />
            <span className="ml-4">{t("video.search_placeholder")}</span>
          </FocusButton>
          {anyFailed && !fullError && (
            // Never focused for you: ▲ reaches it; the page also retries by itself.
            <FocusButton
              focusKey="v-top-retry"
              onPress={retryFailed}
              className={`tv-chip ml-5 flex h-[72px] items-center px-8 text-[26px] font-semibold ${design === "terminal" ? "t-label text-[20px]" : "rounded-control"} bg-surface-2 text-text`}
            >
              <span data-testid="video-retry">
                {t("video.tv.load_failed")} — {t("common.retry")}
              </span>
            </FocusButton>
          )}
        </FocusBlock>
        <div className="absolute left-0 right-0" style={{ top: ROWS_TOP }}>
          {body}
        </div>
      </FocusLine>
      {anyFailed && !fullError && (
        // Pinned to the screen (not the scrolled page), so it is seen wherever focus is; never focusable.
        <p
          data-testid="video-load-error"
          className={`tv-key-hint absolute right-[48px] top-[18px] max-w-[900px] truncate px-6 py-2 text-[22px] text-muted ${design === "terminal" ? "font-mono" : "rounded-full"}`}
        >
          {fetching ? t("video.tv.retrying") : unavailable && focusable.length > 0 ? t("video.tv.stale") : t("video.tv.load_failed_auto")}
        </p>
      )}
      {menu.node}
    </div>
  );
}

function RowHeader({ design, index, title, count }: { design: Design; index: number; title: string; count: number | null }) {
  if (design === "terminal") {
    return (
      <div className="flex items-center" style={{ height: ROW_HEAD }}>
        <h3 className="t-label whitespace-nowrap text-[25px] text-text">
          {indexTag(index)} / {title}
          {count ? <span className="text-accent"> [{count}]</span> : null}
        </h3>
        <span className="t-hair ml-6 w-[300px] border-t" />
      </div>
    );
  }
  return (
    <div className="flex items-center" style={{ height: ROW_HEAD }}>
      <h3 className="truncate text-[31px] font-bold text-text">{title}</h3>
      {count ? <span className="ml-4 text-[24px] text-muted">{count}</span> : null}
    </div>
  );
}

/** 503 video_unavailable: Invidious is down or not configured. */
export function Unavailable({ onRetry, title = true, autoFocus = true }: { onRetry: () => void; title?: boolean; autoFocus?: boolean }) {
  const { t } = useI18n();
  return (
    <div data-testid="video-unavailable" className="max-w-[1200px]">
      {title && <p className="mb-6 text-[44px] font-bold">{t("video.title")}</p>}
      <p className="text-3xl leading-snug text-muted">{t("video.unavailable")}</p>
      <div className="mt-10 flex">
        <FocusButton focusKey="v-retry" onPress={onRetry} autoFocus={autoFocus} className="rounded-2xl bg-accent px-10 py-5 text-3xl font-semibold text-on-accent">
          {t("common.retry")}
        </FocusButton>
      </div>
    </div>
  );
}

/** After the last card of a paged row: «loading more» or a failed page (retried by itself). Not focusable. */
function MoreTile({ g, loading, failed }: { g: { w: number; h: number }; loading: boolean; failed: boolean }) {
  const { t } = useI18n();
  if (!loading && !failed) return null;
  return (
    <div data-testid="video-more" data-failed={failed ? "1" : "0"} className="mt-card flex flex-col items-center justify-center rounded-card border-2 border-dashed border-border px-6 text-center" style={{ width: g.w, height: g.h }}>
      {loading ? <Spinner size={44} /> : null}
      <p className="mt-3 text-[22px] leading-snug text-muted">{loading ? t("video.tv.loading_more") : t("video.tv.more_failed")}</p>
    </div>
  );
}

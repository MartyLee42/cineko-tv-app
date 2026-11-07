// «Видео» → «Поиск»: the on-screen keyboard, YouTube's suggestions for what
// is typed (OK takes one) and the matching videos. Physical keyboards type
// directly, like the catalog search. Results load page by page as focus
// nears the end; a failed page keeps the results and focus, says so under
// them and retries by itself.
import { useEffect, useMemo, useRef, useState } from "react";
import { Spinner, useI18n } from "@martytv/ui";
import { FocusBlock, FocusButton, FocusLine, getCurrentFocusKey, setFocus, useInitialFocus } from "../../focus";
import { applyKey, KEYBOARD_COLS, LAYOUTS, normalizeQuery, physicalKey, type KeyAction, type Layout } from "../../catalog/keyboard";
import { KEY_PITCH, ScreenKeyboard } from "../../components/ScreenKeyboard";
import { cardKey, uniqueById } from "../../catalog/focusKeys";
import type { RouteMemory } from "../../catalog/nav";
import { VGrid } from "../../components/VGrid";
import { ErrorState, GridSkeleton } from "../../components/States";
import { useDesign, useFrame } from "../../design/context";
import { useReportDeep, useToTop } from "../../design/topJump";
import type { VideoItem } from "../../video/logic";
import { isVideoUnavailable, useAutoRetry, useVideoSearch, useVideoSuggestions } from "../../video/queries";
import { wantsMore } from "../../video/logic";
import { useVideoMenu } from "../../video/actions";
import { VideoCard, type VideoGeo } from "../../video/VideoCard";
import { Unavailable } from "./VideoScreen";

const DEBOUNCE = 400;
const G: VideoGeo = { w: 300, h: 169, caption: 96, gap: 26 };

export function VideoSearchScreen({
  mem,
  onPlay,
  onChannel,
}: {
  mem: RouteMemory;
  onPlay: (v: VideoItem, start: number | null) => void;
  onChannel: (channelId: string, name: string) => void;
}) {
  const { t, locale } = useI18n();
  const design = useDesign();
  const frame = useFrame();
  const width = 1920 - frame.x - KEYBOARD_COLS * KEY_PITCH - 140;
  const cols = Math.max(2, Math.floor((width + G.gap) / (G.w + G.gap)));
  const pitchX = G.w + G.gap;
  const pitchY = G.h + G.caption + 24;
  const [text, setText] = useState(() => mem.get<string>("text") ?? "");
  const [layout, setLayout] = useState<Layout>(() => mem.get<Layout>("layout") ?? (locale === "en" ? "en" : "ru"));
  const [q, setQ] = useState(() => normalizeQuery(text));
  const [ty, setTy] = useState(() => mem.get<number>("ty") ?? 0);
  const sugg = useVideoSuggestions(q);
  const search = useVideoSearch(q);
  const items = useMemo(() => uniqueById(search.data?.pages.flatMap((p) => p.videos) ?? []), [search.data]);
  const suggestions = q ? (sugg.data ?? []).filter((s) => normalizeQuery(s).toLowerCase() !== q.toLowerCase()) : [];
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const jumpToResults = useRef(false);
  const menu = useVideoMenu({ onPlay, onChannel });
  const moreFailed = search.isFetchNextPageError;
  useAutoRetry(search.isError, () => void (moreFailed ? search.fetchNextPage() : search.refetch()));
  const more = (i: number) => {
    if (wantsMore(i, items.length, { hasNext: !!search.hasNextPage, fetching: search.isFetching, failed: moreFailed }, cols * 2)) void search.fetchNextPage();
  };
  useEffect(() => {
    if (getCurrentFocusKey()?.startsWith("vs-r")) more(mem.get<number>("idx") ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, search.isFetching]);

  useEffect(() => {
    const h = setTimeout(() => setQ(normalizeQuery(text)), DEBOUNCE);
    return () => clearTimeout(h);
  }, [text]);

  const setQuery = (next: string) => {
    mem.set("text", next);
    setText(next);
  };
  const edit = (a: KeyAction) => {
    // The suggestions/results are rebuilt for the new text: keep focus on the keyboard.
    if (getCurrentFocusKey()?.startsWith("vs-")) setFocus("kb");
    setText((prev) => {
      const next = applyKey(prev, a);
      mem.set("text", next);
      return next;
    });
  };
  const pick = (s: string) => {
    jumpToResults.current = true;
    setQuery(s);
    setQ(normalizeQuery(s));
  };
  // A picked suggestion: focus the first result once it is there.
  const first = items[0];
  useEffect(() => {
    if (!jumpToResults.current || !first || search.isFetching) return;
    jumpToResults.current = false;
    setFocus(cardKey("vs-r", first.id));
  }, [first, search.isFetching]);

  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.key) return;
      const a = physicalKey(e.key, e.ctrlKey || e.metaKey || e.altKey);
      if (!a) return;
      if (a.type === "backspace") {
        if (textRef.current === "") return;
        e.stopPropagation();
      }
      e.preventDefault();
      edit(a);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInitialFocus(true, mem, () => `kb-${LAYOUTS[layout][0]}`);

  const scroll = (v: number) => {
    setTy(v);
    mem.set("ty", v);
  };
  const onIndex = (i: number) => {
    mem.set("idx", i);
    const row = Math.floor(i / cols);
    const top = resultsRef.current?.offsetTop ?? 0;
    scroll(row === 0 ? 0 : top + row * pitchY - 60);
    more(i);
  };
  useToTop(() => {
    scroll(0);
    return false;
  });
  useReportDeep(ty > 0);

  let results: React.ReactNode;
  if (!q) {
    results = <p className="max-w-[900px] text-3xl leading-snug text-muted">{t("video.tv.search_hint")}</p>;
  } else if (isVideoUnavailable(search.error) && items.length === 0) {
    results = <Unavailable autoFocus={false} onRetry={() => void search.refetch()} />;
  } else if (search.isError && items.length === 0) {
    results = <ErrorState focusKey="vs-retry" autoFocus={false} error={search.error} onRetry={() => void search.refetch()} />;
  } else if (search.isPending) {
    results = <GridSkeleton cols={cols} width={G.w} height={G.h} pitchX={pitchX} pitchY={pitchY} />;
  } else if (items.length === 0) {
    results = <p className="max-w-[900px] text-3xl leading-snug text-muted">{t("video.empty.search")}</p>;
  } else {
    results = (
      <VGrid
        key={q}
        focusKey="vs-results"
        items={items}
        itemKey={(v) => cardKey("vs-r", v.id)}
        cols={cols}
        itemWidth={G.w}
        pitchX={pitchX}
        pitchY={pitchY}
        initialIndex={mem.get<number>("idx") ?? 0}
        onIndexChange={onIndex}
        onSelect={(v) => menu.select(v)}
        onLongPress={(v) => menu.more(v)}
        renderItem={(v, focused, i) => <VideoCard v={v} focused={focused} g={G} index={i + 1} />}
      />
    );
    if (search.isFetchingNextPage || moreFailed) {
      results = (
        <>
          {results}
          <p data-testid="video-more" data-failed={moreFailed ? "1" : "0"} className="flex items-center text-[24px] text-muted" style={{ height: 80 }}>
            {search.isFetchingNextPage && <Spinner size={30} />}
            <span className="ml-4">{search.isFetchingNextPage ? t("video.tv.loading_more") : t("video.tv.more_failed")}</span>
          </p>
        </>
      );
    }
  }

  const rightKeys = [...(suggestions.length > 0 ? ["vs-sugg"] : []), ...(items.length > 0 ? ["vs-results"] : [])];
  return (
    <FocusLine
      focusKey="vs-page"
      axis="horizontal"
      keys={rightKeys.length > 0 ? ["kb", "vs-right"] : ["kb"]}
      className="absolute flex overflow-hidden"
      style={{ left: frame.x - 40, paddingLeft: 40, right: 0, top: frame.top + (design === "kinozal" ? 40 : 0), paddingTop: 40, bottom: 1080 - frame.bottom }}
    >
      <div className="shrink-0" style={{ width: KEYBOARD_COLS * KEY_PITCH }}>
        <div
          data-testid="video-search-box"
          className={`mb-8 flex h-24 items-center overflow-hidden border-2 border-border bg-surface px-7 ${design === "terminal" ? "font-mono" : "rounded-card"}`}
          style={{ width: KEYBOARD_COLS * KEY_PITCH - 12 }}
        >
          {text ? (
            <span className="whitespace-pre text-4xl font-semibold">{text.length > 22 ? `…${text.slice(-21)}` : text}</span>
          ) : (
            <span className="truncate text-3xl text-muted">{t("video.search_placeholder")}</span>
          )}
          <span className="tv-caret ml-1 inline-block h-12 w-1 shrink-0 bg-accent" />
        </div>
        <ScreenKeyboard
          layout={layout}
          onAction={edit}
          onLayout={(l) => {
            setLayout(l);
            mem.set("layout", l);
          }}
        />
      </div>

      <div data-testid="video-search" className="relative ml-12 min-w-0 flex-1 overflow-hidden pl-6" style={{ height: frame.bottom - frame.top }}>
        <FocusLine focusKey="vs-right" keys={rightKeys} className="tv-track" style={{ transform: `translate3d(0,${-ty}px,0)` }}>
          {suggestions.length > 0 && (
            <FocusBlock focusKey="vs-sugg" onEnter={() => scroll(0)} className="mb-6">
              <p className="mb-4 text-[22px] text-muted">{t("video.tv.suggestions")}</p>
              <div data-testid="video-suggestions" className="flex flex-wrap" style={{ maxHeight: 180, overflow: "hidden" }}>
                {suggestions.slice(0, 8).map((s) => (
                  <FocusButton
                    key={s}
                    focusKey={`vs-s-${s}`}
                    onPress={() => pick(s)}
                    className={`tv-chip mb-4 mr-4 flex h-[70px] items-center px-7 text-[25px] ${design === "terminal" ? "font-mono text-[21px]" : "rounded-control"} bg-surface-2 text-text`}
                  >
                    <span className="block max-w-[520px] truncate">{s}</span>
                  </FocusButton>
                ))}
              </div>
            </FocusBlock>
          )}
          <div className="mb-6 flex h-12 items-center text-2xl text-muted">
            {q && items.length > 0 && t("video.tv.results")}
            {(search.isFetching || sugg.isFetching) && (
              <span className="ml-4 inline-flex">
                <Spinner size={28} />
              </span>
            )}
          </div>
          <div ref={resultsRef} className="relative">
            {results}
          </div>
        </FocusLine>
      </div>
      {menu.node}
    </FocusLine>
  );
}

import { useEffect, useRef, useState } from "react";
import type { MediaSummary } from "@martytv/contracts";
import { Spinner, useI18n } from "@martytv/ui";
import { FocusLine, getCurrentFocusKey, setFocus, useInitialFocus } from "../../focus";
import { applyKey, KEYBOARD_COLS, LAYOUTS, normalizeQuery, physicalKey, type KeyAction, type Layout } from "../../catalog/keyboard";
import { KEY_PITCH, ScreenKeyboard } from "../../components/ScreenKeyboard";
import { cardKey } from "../../catalog/focusKeys";
import type { RouteMemory } from "../../catalog/nav";
import { isUnavailable, useCatalogConfig, useSearch } from "../../catalog/queries";
import { nearEnd } from "../../catalog/virtual";
import { VGrid } from "../../components/VGrid";
import { useDesign, useFrame } from "../../design/context";
import { GridCard, gridGeo } from "../../design/grid";
import { useReportDeep, useToTop } from "../../design/topJump";
import { ErrorState, GridSkeleton } from "../../components/States";

const DEBOUNCE = 400;

export function SearchScreen({ mem, onOpen }: { mem: RouteMemory; onOpen: (item: MediaSummary, from?: string) => void }) {
  const { t, locale } = useI18n();
  const design = useDesign();
  const frame = useFrame();
  const g = gridGeo(design, 1920 - frame.x - KEYBOARD_COLS * KEY_PITCH - 140);
  const COLS = g.cols;
  const cfg = useCatalogConfig();
  const [text, setText] = useState(() => mem.get<string>("text") ?? "");
  const [layout, setLayout] = useState<Layout>(() => mem.get<Layout>("layout") ?? (locale === "en" ? "en" : "ru"));
  const [q, setQ] = useState(() => normalizeQuery(text));
  const [ty, setTy] = useState(() => mem.get<number>("ty") ?? 0);
  const search = useSearch(q);
  const items = search.data?.items ?? [];

  // Debounced query: typing quickly sends one request.
  useEffect(() => {
    const h = setTimeout(() => setQ(normalizeQuery(text)), DEBOUNCE);
    return () => clearTimeout(h);
  }, [text]);

  const edit = (a: KeyAction) => {
    // The results grid is rebuilt for the new query: keep focus on the keyboard.
    if (getCurrentFocusKey()?.startsWith("s-")) setFocus("kb");
    setText((prev) => {
      const next = applyKey(prev, a);
      mem.set("text", next);
      return next;
    });
  };

  // Physical keyboards (and remotes with letter keys) type directly. Backspace
  // edits the text while there is any; otherwise it stays the Back key.
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

  const onIndex = (i: number) => {
    mem.set("idx", i);
    const row = Math.floor(i / COLS);
    const v = row === 0 ? 0 : row * g.pitchY - 40;
    setTy(v);
    mem.set("ty", v);
    if (nearEnd(i, items.length, COLS * 3) && search.hasNextPage && !search.isFetchingNextPage) void search.fetchNextPage();
  };

  useToTop(() => {
    setTy(0);
    mem.set("ty", 0);
    return false;
  });
  useReportDeep(ty > 0);

  let results: React.ReactNode;
  if (!q) {
    results = <p className="max-w-[900px] text-3xl leading-snug text-muted">{t("catalog.search_hint")}</p>;
  } else if (search.isError) {
    results = (
      <ErrorState
        focusKey="s-retry"
        autoFocus={false}
        error={search.error}
        unavailable={isUnavailable(search.error, cfg.data)}
        onRetry={() => void search.refetch()}
      />
    );
  } else if (search.isPending) {
    results = <GridSkeleton cols={COLS} width={g.w} height={g.h} pitchX={g.pitchX} pitchY={g.pitchY} />;
  } else if (items.length === 0) {
    results = <p className="max-w-[900px] text-3xl leading-snug text-muted">{t("catalog.search_empty", { q })}</p>;
  } else {
    results = (
      <VGrid
        key={q}
        focusKey="s-results"
        items={items}
        itemKey={(it) => cardKey("s", it.id)}
        cols={COLS}
        itemWidth={g.w}
        pitchX={g.pitchX}
        pitchY={g.pitchY}
        initialIndex={mem.get<number>("idx") ?? 0}
        onIndexChange={onIndex}
        onSelect={(it) => onOpen(it, t("catalog.search"))}
        quick={(it) => ({ item: it, onOpen: () => onOpen(it, t("catalog.search")) })}
        renderItem={(it, focused, i) => <GridCard item={it} cfg={cfg.data} g={g} focused={focused} index={i} />}
      />
    );
  }

  return (
    <FocusLine
      focusKey="s-page"
      axis="horizontal"
      keys={items.length > 0 ? ["kb", "s-results"] : ["kb"]}
      className="absolute flex overflow-hidden"
      style={{ left: frame.x - 40, paddingLeft: 40, right: 0, top: frame.top + (design === "kinozal" ? 40 : 0), paddingTop: 40, bottom: 1080 - frame.bottom }}
    >
      <div className="shrink-0" style={{ width: KEYBOARD_COLS * KEY_PITCH }}>
        <div className={`mb-8 flex h-24 items-center overflow-hidden border-2 border-border bg-surface px-7 ${design === "terminal" ? "font-mono" : "rounded-card"}`} style={{ width: KEYBOARD_COLS * KEY_PITCH - 12 }}>
          {text ? (
            <span className="whitespace-pre text-4xl font-semibold">{text.length > 22 ? `…${text.slice(-21)}` : text}</span>
          ) : (
            <span className="truncate text-3xl text-muted">{t("catalog.search_placeholder")}</span>
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

      <div className="relative ml-12 min-w-0 flex-1 overflow-hidden pl-6 pt-0" style={{ height: frame.bottom - frame.top }}>
        <div className="tv-track" style={{ transform: `translate3d(0,${-ty}px,0)` }}>
          <div className="mb-6 flex h-12 items-center text-2xl text-muted">
            {q && search.data && t("catalog.tv.results", { n: search.data.total })}
            {search.isFetching && <span className="ml-4 inline-flex"><Spinner size={28} /></span>}
          </div>
          {results}
        </div>
      </div>
    </FocusLine>
  );
}

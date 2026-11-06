import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FocusContext, useFocusable, type FocusableComponent } from "@noriginmedia/norigin-spatial-navigation";
import type { HistoryItem, MediaSummary } from "@martytv/contracts";
import { episodeCode, imageUrl, placeholderColor } from "@martytv/media-types";
import { historyDate, historyLines, historyView, monthLabel, Spinner, useI18n, type HistoryKind, type HistoryLine, type MessageKey } from "@martytv/ui";
import { FocusBlock, FocusButton, FocusLine, useInitialFocus } from "../../focus";
import { linearNext } from "../../catalog/focusKeys";
import type { RouteMemory } from "../../catalog/nav";
import { useCatalogConfig } from "../../catalog/queries";
import type { Direction } from "../../catalog/virtual";
import { Slot } from "../../components/HRow";
import { Img, legacyColor } from "../../components/Img";
import { ErrorState } from "../../components/States";
import { useDesign, useFrame, type Design } from "../../design/context";
import { ScreenTitle } from "../../design/grid";
import { useReportDeep, useToTop } from "../../design/topJump";
import { useHistory } from "../../foryou/queries";
import { lineWindow, listLayout, listScroll, type ListLayout } from "../../foryou/layout";

const EDGE = 40;
const LIST_TOP = 250;
const GEO = { month: 92, item: 128 };
/** Where the focused line lands below the top of the band. */
const ANCHOR = 300;
const FILTERS: HistoryKind[] = ["all", "movie", "series", "rated"];
const FILTER_LABEL: Record<HistoryKind, MessageKey> = { all: "fy.history.all", movie: "fy.history.movies", series: "fy.history.series", rated: "fy.history.rated" };

/** «История»: everything the profile watched, grouped by month, with its ratings. */
export function HistoryScreen({ mem, onOpen }: { mem: RouteMemory; onOpen: (item: MediaSummary, from?: string) => void }) {
  const { t, locale } = useI18n();
  const design = useDesign();
  const frame = useFrame();
  const cfg = useCatalogConfig();
  const q = useHistory();
  const [kind, setKind] = useState<HistoryKind>(() => mem.get<HistoryKind>("kind") ?? "all");
  const [idx, setIdx] = useState(() => mem.get<number>("idx") ?? 0);
  const [ty, setTy] = useState(() => mem.get<number>("ty") ?? 0);
  const raw = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const lines = useMemo(() => historyLines(historyView(raw, { kind, q: "" })), [raw, kind]);
  const layout = useMemo(() => listLayout(lines, GEO), [lines]);
  const count = layout.items.length;
  const width = 1920 - frame.x - 96;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;

  // Near the end (or a filter with few matches): the next page.
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && (idx >= count - 20 || (kind !== "all" && count < 40))) void fetchNextPage();
  }, [idx, count, kind, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const firstKey = count > 0 ? `h-${lines[layout.items[0]!]!.key}` : null;
  useInitialFocus(!q.isPending, mem, () => firstKey ?? (q.isError ? "h-retry" : "h-f-all"));

  const scroll = (v: number) => {
    setTy(v);
    mem.set("ty", v);
  };
  useToTop(() => {
    scroll(0);
    return false;
  });
  useReportDeep(ty > 0);

  const pickKind = (k: HistoryKind) => {
    setKind(k);
    mem.set("kind", k);
    setIdx(0);
    mem.set("idx", 0);
  };

  let body: ReactNode;
  if (q.isPending) body = <Spinner size={56} />;
  else if (q.isError) body = <ErrorState focusKey="h-retry" error={q.error} onRetry={() => void q.refetch()} />;
  else if (count === 0)
    body = (
      <p data-testid="history-empty" className="text-[30px] text-muted">
        {hasNextPage ? <Spinner size={40} /> : kind === "all" ? t("fy.tv.history_empty") : t("fy.history.no_match")}
      </p>
    );
  else
    body = (
      <HistoryList
        key={kind}
        lines={lines}
        layout={layout}
        width={width}
        initial={idx}
        onIndex={(i) => {
          setIdx(i);
          mem.set("idx", i);
          scroll(i === 0 ? 0 : listScroll(layout, i, ANCHOR - LIST_TOP));
        }}
        renderMonth={(key, n) => <MonthHeader design={design} label={monthLabel(key, t)} count={n} />}
        renderItem={(h, focused) => <HistoryCard h={h} focused={focused} design={design} cfg={cfg.data} locale={locale} width={width} />}
        onSelect={(h) => onOpen(h.media, t("nav.history"))}
      />
    );

  return (
    <div data-testid="history" className="absolute overflow-hidden" style={{ left: frame.x - EDGE, right: 0, top: frame.top, bottom: 1080 - frame.bottom }}>
      <FocusLine focusKey="h-page" keys={count > 0 ? ["h-filters", "h-list"] : ["h-filters"]} className="tv-track absolute right-0 top-0" style={{ left: EDGE, transform: `translate3d(0,${-ty}px,0)` }}>
        <div className="flex h-[136px] items-end pb-6">
          <ScreenTitle design={design} index={7}>
            {t("nav.history")}
          </ScreenTitle>
          {count > 0 && <span className="mb-1 ml-6 text-2xl text-muted">{t("catalog.tv.results", { n: hasNextPage ? `${count}+` : count })}</span>}
          {isFetchingNextPage && (
            <span className="mb-1 ml-6 inline-flex">
              <Spinner size={32} />
            </span>
          )}
        </div>
        <FocusBlock focusKey="h-filters" onEnter={() => scroll(0)} preferredChildFocusKey={`h-f-${kind}`} className="flex pt-4">
          {FILTERS.map((k) => (
            <FocusButton
              key={k}
              focusKey={`h-f-${k}`}
              onPress={() => pickKind(k)}
              className={`tv-chip mr-4 px-8 py-4 text-2xl font-semibold ${design === "terminal" ? "t-label text-[20px]" : "rounded-control"} ${k === kind ? "bg-accent text-on-accent" : "bg-surface-2 text-text"}`}
            >
              {t(FILTER_LABEL[k])}
            </FocusButton>
          ))}
        </FocusBlock>
        <div className="absolute left-0 right-0" style={{ top: LIST_TOP }}>
          {body}
        </div>
      </FocusLine>
    </div>
  );
}

/** Virtualized vertical list: month headers between focusable item lines. */
function HistoryList({
  lines,
  layout,
  width,
  initial,
  onIndex,
  onSelect,
  renderMonth,
  renderItem,
}: {
  lines: HistoryLine<HistoryItem>[];
  layout: ListLayout;
  width: number;
  initial: number;
  onIndex: (i: number) => void;
  onSelect: (h: HistoryItem) => void;
  renderMonth: (key: string, count: number) => ReactNode;
  renderItem: (h: HistoryItem, focused: boolean) => ReactNode;
}) {
  const n = layout.items.length;
  const [focus, setFocusIdx] = useState(() => Math.min(initial, Math.max(0, n - 1)));
  const f = Math.min(focus, Math.max(0, n - 1));
  const keys = layout.items.map((li) => `h-${lines[li]!.key}`);
  const { ref, focusKey } = useFocusable({
    focusKey: "h-list",
    saveLastFocusedChild: true,
    preferredChildFocusKey: keys[f],
    measureChildrenLayout: false,
    nextFocusResolver: (dir: Direction, current: string, siblings: FocusableComponent[]) => {
      const next = linearNext(keys, current, dir, "vertical");
      return next ? (siblings.find((s) => s.focusKey === next) ?? null) : null;
    },
  });
  const [start, end] = lineWindow(layout, f, 8, 10);
  const out: ReactNode[] = [];
  for (let li = start; li < end; li++) {
    const line = lines[li]!;
    const top = layout.tops[li]!;
    if (line.type === "month") {
      out.push(
        <div key={`m-${line.key}`} data-month={line.key} className="absolute left-0" style={{ top, width, height: GEO.month }}>
          {renderMonth(line.key, line.count)}
        </div>,
      );
      continue;
    }
    const i = layout.items.indexOf(li);
    const h = line.item;
    out.push(
      <Slot
        key={line.key}
        focusKey={`h-${line.key}`}
        left={0}
        top={top}
        width={width}
        onFocus={() => {
          setFocusIdx(i);
          onIndex(i);
        }}
        onPress={() => onSelect(h)}
      >
        {(focused) => renderItem(h, focused)}
      </Slot>,
    );
  }
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} data-testid="history-list" className="relative" style={{ height: layout.height, width }}>
        {out}
      </div>
    </FocusContext.Provider>
  );
}

function MonthHeader({ design, label, count }: { design: Design; label: string; count: number }) {
  if (design === "terminal") {
    return (
      <div className="flex h-full items-end pb-4">
        <h3 className="t-label text-[25px] text-accent">{label}</h3>
        <span className="t-label ml-5 text-[19px] text-muted">[{count}]</span>
        <span className="t-hair mb-3 ml-6 w-[400px] border-t" />
      </div>
    );
  }
  return (
    <div className="flex h-full items-end pb-4">
      <h3 className={`text-[34px] font-bold ${design === "projector" ? "p-wide uppercase" : ""}`}>{label}</h3>
      <span className="mb-1 ml-5 text-[24px] text-muted">{count}</span>
    </div>
  );
}

function shortDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function HistoryCard({
  h,
  focused,
  design,
  cfg,
  locale,
  width,
}: {
  h: HistoryItem;
  focused: boolean;
  design: Design;
  cfg: Parameters<typeof imageUrl>[0];
  locale: string;
  width: number;
}) {
  const { t } = useI18n();
  const m = h.media;
  const p = h.progress;
  const rating = m.me?.rating ?? null;
  const code = p.season_number != null && p.episode_number != null ? episodeCode(p.season_number, p.episode_number) : null;
  const sub = [m.year ? String(m.year) : null, t(`catalog.kind.${m.kind}` as MessageKey), code, shortDate(historyDate(h), locale)].filter(Boolean).join("  ·  ");
  const square = design === "terminal";
  return (
    <div
      data-history-id={m.id}
      className={`tv-focus relative flex items-center ${square ? "" : "rounded-control"} ${focused ? "is-focused bg-surface-2" : design === "projector" ? "bg-white/5" : "bg-surface"}`}
      style={{ width, height: GEO.item - 16 }}
    >
      <div className="relative ml-3 shrink-0 overflow-hidden rounded-[8px]" style={{ width: 64, height: 96, background: legacyColor(placeholderColor(m.id)) }}>
        <Img src={imageUrl(cfg, m.poster_path, "w185")} className="absolute left-0 top-0 h-full w-full object-cover" />
      </div>
      <div className="ml-6 min-w-0 flex-1">
        <p className={`truncate text-[30px] leading-tight ${focused ? "font-bold" : "font-semibold"} ${square ? "font-display" : ""}`}>{m.title}</p>
        <p className="mt-2 truncate text-[22px] text-muted">{sub}</p>
      </div>
      {!p.completed && <span className="mr-6 shrink-0 text-[22px] text-muted">{t("fy.history.in_progress")}</span>}
      {rating != null && (
        <span
          data-testid="history-rating"
          className={`mr-6 shrink-0 px-4 text-[26px] font-bold leading-[44px] ${square ? "t-tag font-mono text-accent" : "rounded-full"} ${
            square ? "" : rating >= 7 ? "bg-ok text-white" : rating >= 5 ? "bg-text text-bg" : "bg-danger text-white"
          }`}
        >
          {t("fy.tv.your_rating", { n: rating })}
        </span>
      )}
    </div>
  );
}

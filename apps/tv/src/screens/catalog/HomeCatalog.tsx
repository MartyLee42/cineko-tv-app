import { useEffect, useMemo, useRef, useState } from "react";
import { useNewEpisodes } from "../../newepisodes/data";
import type { ContinueItem, Genre, HomeRow, IptvChannel, MediaSummary } from "@martytv/contracts";
import { rowTitle, useI18n, visibleRows, type MessageKey } from "@martytv/ui";
import { FocusButton, FocusLine, FocusSection, useInitialFocus } from "../../focus";
import { quickMenu } from "../../quick/store";
import { dismiss, track, trackImpressions, useForYouRows, type ForYouItem, type ForYouRow } from "../../foryou/queries";
import { cardKey } from "../../catalog/focusKeys";
import type { RouteMemory } from "../../catalog/nav";
import { isUnavailable, useCatalogConfig, useGenres, useHome, useMediaLazy } from "../../catalog/queries";
import { HRow } from "../../components/HRow";
import { useContinueWatching } from "../../watch/api";
import { barFraction, formatLeft, timeLeft } from "../../watch/resume";
import { ErrorState, RowSkeleton } from "../../components/States";
import { ActionMenu, type MenuAction } from "../../components/ActionMenu";
import { useDesign, useFrame, useSkin, type Design } from "../../design/context";
import { PosterCard, WideCard } from "../../design/cards";
import { KinozalHero, ProjectorHero, TerminalHero, useContinueInfo, type HeroData } from "../../design/hero";
import { useRecoInbox, useRecoSeen, useSettled, useToggleWatchlist, type Recommendation } from "../../design/data";
import { SenderChip } from "../../design/reco";
import { indexTag } from "../../design/format";
import { useReportDeep, useToTop } from "../../design/topJump";
import { setFocus } from "../../focus";
import { CheckIcon, PlusIcon } from "../../design/icons";
import { WaveCheckIcon, WavePlusIcon } from "../../design/waveIcons";
import { useIptvState } from "../../iptv/queries";
import { LiveCard, playLast } from "../../iptv/HomeCard";
import { DismissWhy } from "../../foryou/DismissWhy";
import { FamilyChip, fyReason } from "../../family/Family";
import { useLeninFilm } from "../../catalog/lenin";
import { useCvStats, useGoskino } from "../../catalog/cvData";
import { CvNewsStrip, CvPlanPlaque, CvPlanToast } from "../../design/cvHome";
import { LENIN_CARD_W, LeninCard } from "../../design/cvCards";

/** Hero follows focus only after it rests, so scrolling through a row stays smooth. */
const HERO_DELAY = 380;
/** Full details for the hero (seasons, runtime) are fetched once focus rests. */
const DETAIL_DELAY = 700;

/** Row geometry per design (1920×1080 canvas). The current row ends above the bottom overscan band (≥ 48 px). */
interface Geo {
  /** Top of the rows band. */
  top: number;
  poster: { w: number; h: number };
  wide: { w: number; h: number };
  gap: number;
  header: number;
  /** Space under a card for its caption (0 = none). */
  caption: number;
  /** Room for the focus frame / scale. */
  pad: number;
  /** Every row uses 16:9 cards (Проектор). */
  allWide: boolean;
}

const GEO: Record<Design, Geo> = {
  kinozal: { top: 512, poster: { w: 204, h: 306 }, wide: { w: 360, h: 203 }, gap: 28, header: 58, caption: 76, pad: 24, allWide: false },
  terminal: { top: 758, poster: { w: 144, h: 216 }, wide: { w: 384, h: 216 }, gap: 18, header: 54, caption: 0, pad: 20, allWide: false },
  projector: { top: 712, poster: { w: 204, h: 306 }, wide: { w: 456, h: 256 }, gap: 30, header: 58, caption: 0, pad: 44, allWide: true },
};

/** A Home row: the profile's "Continue watching", «Советуют близкие» or a catalog row. */
type Section =
  | { key: string; title: string; cont: ContinueItem[]; row?: undefined; reco?: undefined; fy?: undefined; live?: undefined; cv?: undefined; gk?: undefined }
  | { key: string; title: string; reco: Recommendation[]; row?: undefined; cont?: undefined; fy?: undefined; live?: undefined; cv?: undefined; gk?: undefined }
  | { key: string; title: string; fy: ForYouRow; row?: undefined; cont?: undefined; reco?: undefined; live?: undefined; cv?: undefined; gk?: undefined }
  | { key: string; title: string; row: HomeRow; cont?: undefined; reco?: undefined; fy?: undefined; live?: undefined; cv?: undefined; gk?: undefined }
  /** «Продолжить смотреть ТВ»: the profile's last live channel. */
  | { key: string; title: string; live: IptvChannel; row?: undefined; cont?: undefined; reco?: undefined; fy?: undefined; cv?: undefined; gk?: undefined }
  /** «Конструктивизм»: «Рекомендуем к просмотру» — «Ленин в Октябре», always first. */
  | { key: string; title: string; cv: MediaSummary; row?: undefined; cont?: undefined; reco?: undefined; fy?: undefined; live?: undefined; gk?: undefined }
  /** «Конструктивизм»: «Рекомендовано Госкино» — Soviet classics. */
  | { key: string; title: string; gk: MediaSummary[]; row?: undefined; cont?: undefined; reco?: undefined; fy?: undefined; live?: undefined; cv?: undefined };
const rowKey = (r: Section) => `row-${r.key}`;
const sectionItems = (r: Section): { id: string }[] =>
  r.live ? [{ id: r.live.id }] : r.cv ? [{ id: r.cv.id }] : r.gk ? r.gk : r.cont ? r.cont.map((c) => c.media) : r.reco ? r.reco.map((x) => x.media) : r.fy ? r.fy.items.map((x) => x.media) : r.row.items;

function rowHeight(g: Geo, r: Section): number {
  const wide = !!r.cont || !!r.live || g.allWide;
  return g.header + (wide ? g.wide.h : g.poster.h) + g.caption + 26;
}

interface Focused {
  item: MediaSummary;
  cont?: ContinueItem;
  reco?: Recommendation;
  /** «Для вас»: why the focused title is recommended. */
  reason?: string;
  row: string;
  rowIndex: number;
}

export function HomeCatalog({
  mem,
  onOpen,
  onContinue,
  onLive,
}: {
  mem: RouteMemory;
  onOpen: (item: MediaSummary, from?: string, at?: { season: number; episode: number } | null) => void;
  /** «Продолжить сразу» (hold OK on a "Continue watching" card): resume without Details. */
  onContinue?: (item: ContinueItem) => void;
  /** «Продолжить смотреть ТВ»: play the last live channel. */
  onLive?: (channel: IptvChannel, list: IptvChannel[]) => void;
}) {
  const { t, locale } = useI18n();
  const design = useDesign();
  const frame = useFrame();
  const g = GEO[design];
  const cfg = useCatalogConfig();
  const home = useHome();
  const cont = useContinueWatching();
  const movieGenres = useGenres("movie");
  const seriesGenres = useGenres("series");
  const contItems = cont.data ?? [];
  // «Новые серии»: the newest unseen episode per series, as «next up» cards.
  const newEp = useNewEpisodes();
  const newItems = useMemo(() => {
    const out: ContinueItem[] = [];
    const seenMedia = new Set<string>();
    for (const it of newEp.data?.items ?? []) {
      if (it.seen || seenMedia.has(it.media.id)) continue;
      seenMedia.add(it.media.id);
      const e = it.episode;
      out.push({ media: it.media, progress: null, next_up: { episode_id: e.id, season_number: e.season_number, episode_number: e.episode_number, name: e.name, air_date: e.air_date } });
    }
    return out;
  }, [newEp.data]);
  const inbox = useRecoInbox();
  const seen = useRecoSeen();
  const recoItems = inbox.data?.items ?? [];
  const unseen = inbox.data?.unseen ?? recoItems.filter((r) => !r.seen_at).length;
  const fy = useForYouRows();
  const fyRows = visibleRows(fy.data?.rows, fy.data?.cold_start ?? false);
  const iptv = useIptvState();
  const lastLive = onLive ? (iptv.data?.last?.channel ?? null) : null;
  const cvOn = useSkin() === "constructivism";
  const lenin = useLeninFilm(cvOn);
  const goskino = useGoskino(cvOn);
  const cvStats = useCvStats(cvOn);
  const rows: Section[] = [
    ...(cvOn && lenin.data ? [{ key: "cv-lenin", title: t("designs.constructivism.recommend"), cv: lenin.data }] : []),
    ...(cvOn && goskino.data?.length ? [{ key: "cv-goskino", title: "Рекомендовано Госкино", gk: goskino.data }] : []),
    ...(contItems.length > 0 ? [{ key: "continue", title: t("watch.continue"), cont: contItems }] : []),
    ...(newItems.length > 0 ? [{ key: "new", title: t("newep.title"), cont: newItems }] : []),
    ...(lastLive ? [{ key: "tv", title: t("iptv.continue_short"), live: lastLive }] : []),
    ...(recoItems.length > 0 ? [{ key: "reco", title: t("reco.row"), reco: recoItems }] : []),
    // «Для вас»: after the profile's own rows, before the catalog.
    ...fyRows.map((r) => ({ key: `fy-${r.id}`, title: rowTitle(r, t), fy: r })),
    ...(home.data?.rows ?? []).filter((r) => r.items.length > 0).map((r) => ({ key: r.key, title: t(`catalog.row.${r.key}` as MessageKey), row: r })),
  ];
  const [rowIdx, setRowIdx] = useState(() => mem.get<number>("row") ?? 0);
  const [hero, setHero] = useState<Focused | null>(() => mem.get<Focused>("hero") ?? null);
  const [inCont, setInCont] = useState(false);
  const [contMenu, setContMenu] = useState<{ item: ContinueItem; title: string; actions: MenuAction[] } | null>(null);
  const [why, setWhy] = useState<{ mediaId: string; title: string; target: string | null } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  /** The focused «Для вас» card (for the ☰ key). */

  /** «Не интересно» from a «Для вас» card's quick actions: focus moves to the neighbour (or the next row when this one empties), then «Почему?». */
  const dismissFy = (row: Section, r: number, it: ForYouItem, i: number) => {
    const fyRow = row.fy!;
    const rest = fyRow.items.filter((x) => x.media.id !== it.media.id);
    const next = rest[Math.min(i, rest.length - 1)];
    const nextRow = rows[r + 1];
    const target = next ? cardKey(rowKey(row), next.media.id) : nextRow ? cardKey(rowKey(nextRow), sectionItems(nextRow)[0]!.id) : null;
    if (next) mem.set(`idx-${row.key}`, Math.min(i, rest.length - 1));
    dismiss(it.media.id, fyRow.id);
    // «Почему?»: reason chips (+ optional comment) saved as a note; focus returns after.
    setWhy({ mediaId: it.media.id, title: it.media.title, target });
  };

  const unavailable = isUnavailable(home.error ?? cfg.error, cfg.data);
  // Nothing to focus in the content: park focus on the menu.
  useInitialFocus(unavailable, mem, () => "menu-home");
  // Wait for the continue / recommendations rows too (briefly), so focus starts on the first row.
  const ready = rows.length > 0 && !cont.isPending && !inbox.isPending && !fy.isPending && !iptv.isLoading && !(cvOn && (lenin.isPending || goskino.isPending));
  useInitialFocus(ready, mem, () => (rows[0] ? cardKey(rowKey(rows[0]), sectionItems(rows[0])[0]!.id) : undefined));

  const focusItem = (r: number, row: Section, i: number, f: Focused) => {
    if (row.fy) trackImpressions(row.fy.id, row.fy.items.map((x) => x.media.id));
    setRowIdx(r);
    setInCont(!!row.cont);
    mem.set("row", r);
    mem.set(`idx-${row.key}`, i);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setHero(f);
      mem.set("hero", f);
    }, HERO_DELAY);
  };

  const first = rows[0];
  // Back / Channel▲ deep in the rows: first back to the first row (then the menu).
  const deepRow = Math.min(rowIdx, Math.max(0, rows.length - 1)) > 0;
  useToTop((toMenu) => {
    if (!deepRow || !first) return false;
    if (toMenu) {
      // Runs once the shell has focused the menu: just scroll back.
      setRowIdx(0);
      mem.set("row", 0);
      return false;
    }
    // The first row may be virtualized away: bring it back, then focus its remembered card.
    setRowIdx(0);
    mem.set("row", 0);
    const items = sectionItems(first);
    const card = items[Math.min(items.length - 1, mem.get<number>(`idx-${first.key}`) ?? 0)];
    setTimeout(() => card && setFocus(cardKey(rowKey(first), card.id)), 0);
    return true;
  });
  useReportDeep(deepRow);
  // The hero shows titles: the live TV row has none.
  const hf = rows.find((r) => !r.live);
  const shown: Focused | null =
    hero ??
    (hf
      ? hf.cont
        ? { item: hf.cont[0]!.media, cont: hf.cont[0], row: hf.title, rowIndex: 0 }
        : hf.reco
          ? { item: hf.reco[0]!.media, reco: hf.reco[0], row: hf.title, rowIndex: 0 }
          : hf.fy
            ? { item: hf.fy.items[0]!.media, reason: fyReason(hf.fy, hf.fy.items[0]!, t), row: hf.title, rowIndex: 0 }
            : hf.cv
              ? { item: hf.cv, row: hf.title, rowIndex: 0 }
              : hf.gk
              ? { item: hf.gk[0]!, row: hf.title, rowIndex: 0 }
              : hf.row
                ? { item: hf.row.items[0]!, row: hf.title, rowIndex: 0 }
                : null
      : null);
  const settledId = useSettled(shown?.item.id ?? null, DETAIL_DELAY);
  const detail = useMediaLazy(settledId);
  const genreNames = useMemo(() => {
    const all = new Map<number, string>();
    for (const x of [...(movieGenres.data ?? []), ...(seriesGenres.data ?? [])] as Genre[]) all.set(x.id, x.name);
    return all;
  }, [movieGenres.data, seriesGenres.data]);

  if (unavailable || home.isError) {
    return (
      <div className="flex h-full items-center" style={{ paddingLeft: frame.x }}>
        <ErrorState focusKey="home-retry" error={home.error} unavailable={unavailable} onRetry={() => void home.refetch()} />
      </div>
    );
  }

  const ri = Math.min(rowIdx, Math.max(0, rows.length - 1));
  const tops: number[] = [];
  let acc = 0;
  for (const r of rows) {
    tops.push(acc);
    acc += rowHeight(g, r);
  }
  const heroData: HeroData | null = shown
    ? {
        ...shown,
        detail: detail.data && detail.data.id === shown.item.id ? detail.data : undefined,
        genres:
          detail.data && detail.data.id === shown.item.id
            ? detail.data.genres.map((x) => x.name)
            : shown.item.genre_ids.map((id) => genreNames.get(id)).filter((x): x is string => !!x),
      }
    : null;
  const viewport = 1920 - frame.x;
  const withHeroActions = design === "projector" && !!shown;
  const keys = rows.map(rowKey);

  const renderRow = (row: Section, r: number) => {
    const wide = !!row.cont || !!row.live || g.allWide;
    const size = wide ? g.wide : g.poster;
    const current = r === ri;
    return (
      <section key={row.key} data-row={row.key} className="absolute left-0 w-full" style={{ top: tops[r] }}>
        <RowHeader design={design} index={r + 1} title={row.title} current={current} height={g.header} badge={row.reco && unseen > 0 ? t("reco.new", { n: unseen }) : null} />
        <div style={{ marginTop: -g.pad }}>
          {row.cv ? (
            <HRow
              focusKey={rowKey(row)}
              items={[row.cv]}
              itemKey={(it) => cardKey(rowKey(row), it.id)}
              itemWidth={LENIN_CARD_W}
              itemHeight={g.poster.h + g.caption}
              gap={g.gap}
              pad={g.pad}
              viewport={viewport}
              onIndexChange={(i, it) => focusItem(r, row, i, { item: it, row: row.title, rowIndex: r })}
              onSelect={(it) => onOpen(it, row.title)}
              quick={(it) => ({ item: it, onOpen: () => onOpen(it, row.title) })}
              renderItem={(it, focused) => <LeninCard media={it} cfg={cfg.data} height={g.poster.h} focused={focused} />}
            />
          ) : row.gk ? (
            <HRow
              focusKey={rowKey(row)}
              items={row.gk}
              itemKey={(it) => cardKey(rowKey(row), it.id)}
              itemWidth={size.w}
              itemHeight={size.h + g.caption}
              gap={g.gap}
              pad={g.pad}
              viewport={viewport}
              initialIndex={mem.get<number>(`idx-${row.key}`) ?? 0}
              onIndexChange={(i, it) => focusItem(r, row, i, { item: it, row: row.title, rowIndex: r })}
              onSelect={(it) => onOpen(it, row.title)}
              quick={(it) => ({ item: it, onOpen: () => onOpen(it, row.title) })}
              renderItem={(it, focused, i) => <PosterCard item={it} cfg={cfg.data} width={size.w} height={size.h} focused={focused} index={i + 1} showTitle={g.caption > 0} />}
            />
          ) : row.live ? (
            <HRow
              focusKey={rowKey(row)}
              items={[row.live]}
              itemKey={(c) => cardKey(rowKey(row), c.id)}
              itemWidth={size.w}
              itemHeight={size.h + g.caption}
              gap={g.gap}
              pad={g.pad}
              viewport={viewport}
              onIndexChange={() => {
                setRowIdx(r);
                setInCont(false);
                mem.set("row", r);
              }}
              onSelect={(c) => onLive && playLast(c, onLive)}
              renderItem={(c, focused) => <LiveCard channel={c} focused={focused} w={size.w} h={size.h} caption={g.caption > 0} />}
            />
          ) : row.reco ? (
            <HRow
              focusKey={rowKey(row)}
              items={row.reco}
              itemKey={(it) => cardKey(rowKey(row), it.media.id)}
              itemWidth={size.w}
              itemHeight={size.h + g.caption}
              gap={g.gap}
              pad={g.pad}
              viewport={viewport}
              initialIndex={mem.get<number>(`idx-${row.key}`) ?? 0}
              onIndexChange={(i, it) => focusItem(r, row, i, { item: it.media, reco: it, row: row.title, rowIndex: r })}
              onSelect={(it) => {
                if (!it.seen_at) seen.mutate(it.id);
                onOpen(it.media, row.title);
              }}
              quick={(it) => ({
                item: it.media,
                onOpen: () => {
                  if (!it.seen_at) seen.mutate(it.id);
                  onOpen(it.media, row.title);
                },
              })}
              renderItem={(it, focused, i) => {
                const chip = <SenderChip r={it} design={design} index={i + 1} />;
                return wide ? (
                  <WideCard media={it.media} title={it.media.title} cfg={cfg.data} width={size.w} height={size.h} focused={focused} overlay={chip} />
                ) : (
                  <PosterCard item={it.media} cfg={cfg.data} width={size.w} height={size.h} focused={focused} showTitle={g.caption > 0} overlay={chip} />
                );
              }}
            />
          ) : row.fy ? (
            <HRow
              focusKey={rowKey(row)}
              items={row.fy.items}
              itemKey={(it) => cardKey(rowKey(row), it.media.id)}
              itemWidth={size.w}
              itemHeight={size.h + g.caption}
              gap={g.gap}
              pad={g.pad}
              viewport={viewport}
              initialIndex={mem.get<number>(`idx-${row.key}`) ?? 0}
              onIndexChange={(i, it) => focusItem(r, row, i, { item: it.media, reason: fyReason(row.fy!, it, t), row: row.title, rowIndex: r })}
              onSelect={(it) => {
                track(it.media.id, "open", row.fy!.id);
                onOpen(it.media, row.title);
              }}
              // Holding OK (or ☰ / Info): ♥, «Буду смотреть», the rating, «Не интересно» (focus moves on, «Почему?»), «Подробнее».
              quick={(it, i) => ({
                item: it.media,
                rowId: row.fy!.id,
                onDismiss: () => dismissFy(row, r, it, i),
                onOpen: () => (track(it.media.id, "open", row.fy!.id), onOpen(it.media, row.title)),
              })}
              renderItem={(it, focused, i) => {
                // «Семья советует»: who liked it, on the card.
                const chip = row.fy!.kind === "family" ? <FamilyChip item={it} design={design} /> : undefined;
                return wide ? (
                  <WideCard media={it.media} title={it.media.title} cfg={cfg.data} width={size.w} height={size.h} focused={focused} overlay={chip} />
                ) : (
                  <PosterCard item={it.media} cfg={cfg.data} width={size.w} height={size.h} focused={focused} index={i + 1} showTitle={g.caption > 0} overlay={chip} />
                );
              }}
            />
          ) : row.cont ? (
            <HRow
              focusKey={rowKey(row)}
              items={row.cont}
              itemKey={(it) => cardKey(rowKey(row), it.media.id)}
              itemWidth={size.w}
              itemHeight={size.h + g.caption}
              gap={g.gap}
              pad={g.pad}
              viewport={viewport}
              initialIndex={mem.get<number>(`idx-${row.key}`) ?? 0}
              onIndexChange={(i, it) => focusItem(r, row, i, { item: it.media, cont: it, row: row.title, rowIndex: r })}
              // OK opens Details on the in-progress episode; holding OK offers resuming at once.
              onSelect={(it) => onOpen(it.media, row.title, resumeTarget(it))}
              onLongPress={(it) =>
                setContMenu({
                  item: it,
                  title: it.media.title,
                  actions: [
                    ...(onContinue ? [{ key: "resume", label: `▶  ${t("tvd.cont.resume_now")}`, primary: true, onPress: () => (setContMenu(null), onContinue(it)) }] : []),
                    { key: "open", label: t("tvd.cont.open"), onPress: () => (setContMenu(null), onOpen(it.media, row.title, resumeTarget(it))) },
                    { key: "quick", label: t("quick.menu"), onPress: () => (setContMenu(null), quickMenu.open({ item: it.media, onOpen: () => onOpen(it.media, row.title, resumeTarget(it)) })) },
                  ],
                })
              }
              renderItem={(it, focused, i) => <ContinueCard item={it} focused={focused} index={i + 1} w={size.w} h={size.h} locale={locale} fresh={row.key === "new"} />}
            />
          ) : (
            <HRow
              focusKey={rowKey(row)}
              items={row.row.items}
              itemKey={(it) => cardKey(rowKey(row), it.id)}
              itemWidth={size.w}
              itemHeight={size.h + g.caption}
              gap={g.gap}
              pad={g.pad}
              viewport={viewport}
              initialIndex={mem.get<number>(`idx-${row.key}`) ?? 0}
              onIndexChange={(i, it) => focusItem(r, row, i, { item: it, row: row.title, rowIndex: r })}
              onSelect={(it) => onOpen(it, row.title)}
              quick={(it) => ({ item: it, onOpen: () => onOpen(it, row.title) })}
              renderItem={(it, focused, i) =>
                wide ? (
                  <WideCard media={it} title={it.title} cfg={cfg.data} width={size.w} height={size.h} focused={focused} />
                ) : (
                  <PosterCard item={it} cfg={cfg.data} width={size.w} height={size.h} focused={focused} index={i + 1} showTitle={g.caption > 0} />
                )
              }
            />
          )}
        </div>
      </section>
    );
  };

  const Hero = design === "terminal" ? TerminalHero : design === "projector" ? ProjectorHero : KinozalHero;
  return (
    <div className="relative h-full w-full overflow-hidden">
      <Hero data={heroData} cfg={cfg.data} loading={home.isPending}>
        {withHeroActions && heroData && <HeroActions data={heroData} onOpen={onOpen} onContinue={onContinue} />}
      </Hero>
      {/* The band reaches left of the text column so the focus frame isn't clipped. */}
      <div className="absolute overflow-hidden" style={{ left: frame.x - g.pad, paddingLeft: g.pad, right: 0, top: g.top - 12, paddingTop: 12, bottom: 1080 - frame.bottom }}>
        {home.isPending ? (
          <div className="pt-2">
            <RowSkeleton count={8} width={g.poster.w} height={g.poster.h} />
          </div>
        ) : (
          <FocusLine
            focusKey="home-rows"
            keys={keys}
            preferred={rows[ri] ? rowKey(rows[ri]) : undefined}
            className="tv-track absolute right-0"
            style={{ left: g.pad, top: 12, transform: `translate3d(0,${-(tops[ri] ?? 0)}px,0)` }}
          >
            {rows.map((row, r) => (Math.abs(r - ri) > 2 ? null : renderRow(row, r)))}
          </FocusLine>
        )}
      </div>
      {cvOn && (
        <>
          <CvNewsStrip top={frame.top} />
          {cvStats.data && <CvPlanPlaque plan={cvStats.data.plan} hero={cvStats.data.hero} left={930} top={590} />}
          {cvStats.data && <CvPlanToast titles={cvStats.data.fresh} />}
        </>
      )}
      {contMenu && <ActionMenu title={contMenu.title} actions={contMenu.actions} testId="continue-menu" onCancel={() => setContMenu(null)} />}
      {why && (
        <DismissWhy
          mediaId={why.mediaId}
          title={why.title}
          onClose={() => {
            const target = why.target;
            setWhy(null);
            if (target) setTimeout(() => setFocus(target), 0);
          }}
        />
      )}
      {design === "kinozal" && inCont && (
        <div className="tv-key-hint absolute bottom-[26px] right-[40px] rounded-[12px] px-6 py-3 text-[22px] text-text/85">{t("tvd.hint.continue")}</div>
      )}
    </div>
  );
}

function RowHeader({ design, index, title, current, height, badge }: { design: Design; index: number; title: string; current: boolean; height: number; badge?: string | null }) {
  if (design === "terminal") {
    return (
      <div className="flex items-center" style={{ height }}>
        <h3 className={`t-label whitespace-nowrap text-[25px] ${current ? "text-text" : "text-muted"}`}>
          {indexTag(index)} / {title}
        </h3>
        {badge && <span className="t-label ml-6 text-[19px] text-accent">{badge}</span>}
        <span className="t-hair ml-6 w-[300px] border-t" />
      </div>
    );
  }
  return (
    <div className="flex items-center" style={{ height }}>
      <h3 className={`truncate text-[31px] font-bold ${current || design === "projector" ? "text-text" : "text-text/70"}`}>{title}</h3>
      {badge && <span data-testid="reco-unseen" className="ml-5 text-[22px] font-bold text-accent">{badge}</span>}
    </div>
  );
}

/**
 * Projector hero buttons: «▶ Смотреть С1·Э6» + round «+» (watchlist). A
 * sibling of the rows inside the content section, so Up from the first row
 * reaches them by geometry.
 */
function HeroActions({ data, onOpen, onContinue }: { data: HeroData; onOpen: (item: MediaSummary, from?: string) => void; onContinue?: (item: ContinueItem) => void }) {
  const { t } = useI18n();
  const cont = useContinueInfo(data.cont);
  const toggle = useToggleWatchlist();
  const [listed, setListed] = useState<Record<string, boolean>>({});
  const wave = useSkin() === "wireframe";
  const on = listed[data.item.id] ?? !!data.item.me?.in_watchlist;
  const label = cont?.code ? t("tvd.hero.play_ep", { code: cont.code }) : t("tvd.hero.play");
  return (
    <FocusSection focusKey="hero-actions" className="flex">
      <FocusButton
        focusKey="hero-play"
        onPress={() => (data.cont && onContinue ? onContinue(data.cont) : onOpen(data.item, data.row))}
        className="p-primary flex h-[72px] items-center rounded-full bg-white px-[40px] text-[27px] font-medium text-black"
      >
        <span className="mr-4 text-[22px]">▶</span>
        {label}
      </FocusButton>
      <FocusButton
        focusKey="hero-list"
        onPress={() => {
          setListed((m) => ({ ...m, [data.item.id]: !on }));
          toggle.mutate({ mediaId: data.item.id, on: !on });
        }}
        className="p-glass ml-5 flex h-[72px] w-[72px] items-center justify-center rounded-full"
      >
        {wave ? on ? <WaveCheckIcon size={32} stroke={2.4} /> : <WavePlusIcon size={32} stroke={2.4} /> : on ? <CheckIcon size={32} stroke={2.4} /> : <PlusIcon size={32} stroke={2.4} />}
      </FocusButton>
    </FocusSection>
  );
}

/** "Continue watching" card: the episode / time left and a progress bar. */
function ContinueCard({ item, focused, index, w, h, locale, fresh }: { item: ContinueItem; focused: boolean; index: number; w: number; h: number; locale: string; fresh?: boolean }) {
  const { t } = useI18n();
  const design = useDesign();
  const cfg = useCatalogConfig();
  const info = useContinueInfo(item);
  const p = item.progress && !item.progress.completed ? item.progress : null;
  const left = p ? timeLeft(p) : null;
  const leftText = left !== null ? t("tvd.hero.left", { left: formatLeft(left, locale) }) : null;
  const sub = design === "projector" ? (info?.code ?? null) : [info?.code, leftText].filter(Boolean).join(" · ") || null;
  const frac = p ? barFraction(p.percent) : null;
  return (
    <div data-continue-id={item.media.id}>
      <WideCard
        media={item.media}
        title={item.media.title}
        sub={sub}
        progress={frac}
        cfg={cfg.data}
        width={w}
        height={h}
        focused={focused}
        index={index}
        badge={fresh ? t("newep.badge_new") : item.next_up && !p ? t("tv.watch.next_up") : null}
      />
    </div>
  );
}

/** The episode a "Continue watching" item resumes (series), for Details. */
function resumeTarget(it: ContinueItem): { season: number; episode: number } | null {
  const p = it.progress && !it.progress.completed ? it.progress : null;
  if (p && p.season_number !== null && p.episode_number !== null) return { season: p.season_number, episode: p.episode_number };
  if (it.next_up) return { season: it.next_up.season_number, episode: it.next_up.episode_number };
  return null;
}

// «ТВ»: live channels by group with now/next. OK plays; holding OK (or ☰)
// offers the favorite toggle.
import { useEffect, useMemo, useState } from "react";
import type { IptvChannel } from "@martytv/contracts";
import { Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { FocusBlock, FocusLine, getCurrentFocusKey, useInitialFocus } from "../../focus";
import { cardKey } from "../../catalog/focusKeys";
import type { RouteMemory } from "../../catalog/nav";
import { HRow } from "../../components/HRow";
import { VGrid } from "../../components/VGrid";
import { ActionMenu, type MenuAction } from "../../components/ActionMenu";
import { ErrorState, GridSkeleton } from "../../components/States";
import { Brackets } from "../../design/cards";
import { useDesign, useFrame, type Design } from "../../design/context";
import { ScreenTitle } from "../../design/grid";
import { TERMINAL_MENU, visibleMenu } from "../../design/menuOrder";
import { useServerFeatures } from "../../design/data";
import { useReportDeep, useToTop } from "../../design/topJump";
import { channelChips, epgProgress, filterGroup, hhmm, offlineLabel, type Chip } from "../../iptv/logic";
import { ChannelLogo, EpgBar } from "../../iptv/ChannelLogo";
import { setFavorite, useIptvChannels } from "../../iptv/queries";

const EDGE = 40;
const ROW_TOP = 110;
const GRID_TOP = 270;

interface TileGeo {
  cols: number;
  w: number;
  h: number;
  pitchX: number;
  pitchY: number;
}

function tileGeo(design: Design, width: number): TileGeo {
  const w = design === "projector" ? 410 : 396;
  const gap = design === "terminal" ? 20 : 28;
  const h = design === "terminal" ? 178 : 192;
  const cols = Math.max(2, Math.floor((width + gap) / (w + gap)));
  return { cols, w, h, pitchX: w + gap, pitchY: h + gap + 8 };
}

export function TvChannelsScreen({
  mem,
  onPlay,
  onDay,
}: {
  mem: RouteMemory;
  onPlay: (channel: IptvChannel, list: IptvChannel[]) => void;
  /** «Программа на сегодня» of a channel. */
  onDay?: (channel: IptvChannel) => void;
}) {
  const { t } = useI18n();
  const features = useServerFeatures();
  const design = useDesign();
  const frame = useFrame();
  const width = 1920 - frame.x - 72;
  const g = tileGeo(design, width);
  const q = useIptvChannels();
  const all = useMemo(() => q.data?.items ?? [], [q.data]);
  const chips = useMemo(() => channelChips(q.data?.groups ?? [], all), [q.data, all]);
  const [group, setGroup] = useState(() => mem.get<string>("group") ?? "all");
  const active = chips.some((c) => c.id === group) ? group : "all";
  const items = useMemo(() => filterGroup(all, active), [all, active]);
  const [ty, setTy] = useState(() => mem.get<number>("ty") ?? 0);
  const [menu, setMenu] = useState<{ channel: IptvChannel; actions: MenuAction[] } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const chipLabel = (c: Chip) => (c.key ? t(c.key as MessageKey) : c.name);
  useInitialFocus(!q.isPending, mem, () => (items[0] ? cardKey("ch", items[0].id) : cardKey("grp", "all")));

  const scroll = (v: number) => {
    setTy(v);
    mem.set("ty", v);
  };
  const pickGroup = (id: string) => {
    if (id === active) return;
    setGroup(id);
    mem.set("group", id);
    mem.set("idx", 0);
    scroll(0);
  };
  const onIndex = (i: number) => {
    mem.set("idx", i);
    const row = Math.floor(i / g.cols);
    scroll(row === 0 ? 0 : GRID_TOP + row * g.pitchY - ROW_TOP);
  };
  useToTop(() => {
    scroll(0);
    return false;
  });
  useReportDeep(ty > 0);

  const openMenu = (c: IptvChannel) =>
    setMenu({
      channel: c,
      actions: [
        { key: "play", label: `▶  ${t("iptv.tv.watch")}`, primary: true, onPress: () => (setMenu(null), onPlay(c, items)) },
        {
          key: "favorite",
          label: c.favorite ? `☆  ${t("iptv.unfavorite")}` : `★  ${t("iptv.favorite")}`,
          onPress: () => {
            setMenu(null);
            void setFavorite(c, !c.favorite).catch(() => undefined);
          },
        },
        ...(onDay ? [{ key: "day", label: `📅  ${t("iptv.day.open")}`, onPress: () => (setMenu(null), onDay(c)) }] : []),
      ],
    });
  // ☰ / Tools / ContextMenu on a channel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (menu || !(e.key === "ContextMenu" || e.keyCode === 93 || e.keyCode === 10135)) return;
      const k = getCurrentFocusKey() ?? "";
      const c = k.startsWith("ch-") ? items.find((x) => cardKey("ch", x.id) === k) : undefined;
      if (!c) return;
      e.preventDefault();
      openMenu(c);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  let grid: React.ReactNode;
  if (q.isError) {
    grid = <ErrorState focusKey="ch-retry" error={q.error} onRetry={() => void q.refetch()} />;
  } else if (q.isPending) {
    grid = <GridSkeleton cols={g.cols} width={g.w} height={g.h} pitchX={g.pitchX} pitchY={g.pitchY} />;
  } else if (all.length === 0) {
    grid = <p data-testid="tv-empty" className="max-w-[1200px] text-3xl leading-snug text-muted">{t("iptv.empty")}</p>;
  } else if (items.length === 0) {
    grid = <p className="text-3xl text-muted">{t("iptv.empty_group")}</p>;
  } else {
    grid = (
      <VGrid
        key={active}
        focusKey="ch-grid"
        items={items}
        itemKey={(c) => cardKey("ch", c.id)}
        cols={g.cols}
        itemWidth={g.w}
        pitchX={g.pitchX}
        pitchY={g.pitchY}
        initialIndex={mem.get<number>("idx") ?? 0}
        onIndexChange={onIndex}
        onSelect={(c) => onPlay(c, items)}
        onLongPress={(c) => openMenu(c)}
        renderItem={(c, focused) => <ChannelTile channel={c} focused={focused} design={design} g={g} now={now} />}
      />
    );
  }

  return (
    <div data-testid="tv-channels" className="absolute overflow-hidden" style={{ left: frame.x - EDGE, right: 0, top: frame.top, bottom: 1080 - frame.bottom }}>
      <FocusLine
        focusKey="ch-page"
        keys={items.length > 0 ? ["ch-groups", "ch-grid"] : ["ch-groups"]}
        className="tv-track absolute right-0 top-0"
        style={{ left: EDGE, transform: `translate3d(0,${-ty}px,0)` }}
      >
        <div className="flex h-[136px] items-end pb-6">
          <ScreenTitle design={design} index={visibleMenu(TERMINAL_MENU, features).indexOf("tv") + 1}>
            {t("iptv.title")}
          </ScreenTitle>
          {q.data && <span className="mb-1 ml-6 text-2xl text-muted">{t("iptv.tv.count", { n: items.length })}</span>}
          {q.isFetching && !q.isPending && (
            <span className="mb-1 ml-6 inline-flex">
              <Spinner size={28} />
            </span>
          )}
          {items.length > 0 && <span className="mb-1 ml-auto mr-12 text-[22px] text-muted">{t("iptv.tv.screen_hint")}</span>}
        </div>
        <FocusBlock focusKey="ch-groups" onEnter={() => scroll(0)} className="pt-2">
          {chips.length > 0 && !q.isPending && (
            <HRow
              focusKey="ch-groups-row"
              items={chips}
              itemKey={(c) => cardKey("grp", c.id)}
              itemWidth={250}
              itemHeight={76}
              gap={16}
              viewport={width}
              initialIndex={Math.max(0, chips.findIndex((c) => c.id === active))}
              onSelect={(c) => pickGroup(c.id)}
              renderItem={(c, focused) => (
                <div
                  data-group={c.id}
                  className={`tv-focus tv-chip flex h-[76px] items-center justify-center px-5 text-[24px] font-semibold ${design === "terminal" ? "t-label text-[19px]" : "rounded-control"} ${
                    focused ? "is-focused" : c.id === active ? "bg-accent text-on-accent" : "bg-surface-2 text-text"
                  }`}
                >
                  <span className="truncate">{chipLabel(c)}</span>
                  <span className="ml-2 shrink-0 opacity-60">{c.count}</span>
                </div>
              )}
            />
          )}
        </FocusBlock>
        <div className="absolute left-0 right-0" style={{ top: GRID_TOP }}>
          {grid}
        </div>
      </FocusLine>
      {menu && <ActionMenu title={menu.channel.name} subtitle={menu.channel.now?.title ?? null} actions={menu.actions} testId="tv-channel-menu" onCancel={() => setMenu(null)} />}
    </div>
  );
}

function ChannelTile({ channel: c, focused, design, g, now }: { channel: IptvChannel; focused: boolean; design: Design; g: TileGeo; now: number }) {
  const { t } = useI18n();
  const terminal = design === "terminal";
  const frac = epgProgress(c.now, now);
  return (
    <div data-channel-id={c.id} data-offline={c.offline ? "1" : undefined} className="relative" style={{ width: g.w, height: g.h }}>
      <div
        className={`tv-focus relative flex h-full w-full overflow-hidden px-5 py-4 ${terminal ? "tv-panel tv-panel-bg border border-text/15" : design === "projector" ? "tv-panel rounded-[22px]" : "tv-panel rounded-card"} ${
          focused ? "is-focused" : ""
        }`}
      >
        <div className={`flex shrink-0 flex-col items-center ${c.offline ? "opacity-40" : ""}`} style={{ width: 120 }}>
          <ChannelLogo channel={c} w={120} h={90} className={`${terminal ? "" : "rounded-[12px]"} bg-white/10`} />
          <span className={`mt-3 text-[26px] font-bold ${focused ? "text-accent" : "text-muted"} ${terminal ? "font-mono" : ""}`}>{c.number}</span>
        </div>
        <div className={`ml-5 min-w-0 flex-1 ${c.offline ? "opacity-50" : ""}`}>
          <p className={`truncate text-[26px] font-bold leading-tight text-text ${terminal ? "t-label text-[21px]" : ""} ${c.favorite ? "pr-8" : ""}`}>{c.name}</p>
          {c.now ? (
            <>
              <p className="mt-2 truncate text-[22px] leading-tight text-text/85">{c.now.title}</p>
              <EpgBar fraction={frac} className="mt-3 w-full" />
              {c.next && (
                <p className="mt-3 truncate text-[19px] text-muted">
                  {hhmm(c.next.start)} · {c.next.title}
                </p>
              )}
            </>
          ) : (
            <p className="mt-2 truncate text-[21px] text-muted">{c.offline ? t(offlineLabel(c)) : t("iptv.no_epg")}</p>
          )}
        </div>
        {c.favorite && <span className="absolute right-4 top-3 text-[26px] text-accent">★</span>}
      </div>
      {terminal && focused && <Brackets small />}
    </div>
  );
}

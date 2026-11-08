// Navigation chrome per design: Кинозал's icon rail, Терминал's numbered tab
// bar + status ticker, Проектор's centred pill tabs. All share focus keys
// (`menu`, `menu-<id>`) so screens and App can move focus without knowing
// the design.
import type { ReactNode } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import type { Profile } from "@martytv/contracts";
import { cvMenuLabel, CvIcon, Mascot, ProfileAvatar, useAppliedDesign, useI18n } from "@martytv/ui";
import { useDevice, usePlural, useSkin, RAIL_W } from "./context";
import { useClock, useServerFeatures, useServerStatus } from "./data";
import { clockText, tickerItems, tickerSeconds, torrState } from "./format";
import { BookmarkIcon, ClockIcon, CompassIcon, DiceIcon, FilmIcon, HomeIcon, LiveTvIcon, MessageIcon, NewEpisodesIcon, PlayTileIcon, SearchIcon, SlidersIcon, SparkIcon, TvIcon } from "./icons";
import {
  WaveAskIcon,
  WaveDiceIcon,
  WaveExploreIcon,
  WaveFilmIcon,
  WaveHistoryIcon,
  WaveHomeIcon,
  WaveLiveIcon,
  WaveMessageIcon,
  WaveMineIcon,
  WaveNewIcon,
  WaveSearchIcon,
  WaveSeriesIcon,
  WaveSlidersIcon,
  WaveVideoIcon,
} from "./waveIcons";
import { KINOZAL_MENU, PROJECTOR_ICONS, PROJECTOR_TEXT, railIndicatorTop, TERMINAL_MENU, visibleMenu, type MenuId } from "./menuOrder";

export type { MenuId };

export interface NavProps {
  active: MenuId | null;
  profile: Profile;
  unread: number;
  /** Items in "Моё" (Терминал shows the count). */
  mine: number | null;
  /** Unseen «Новые серии» (badge on the tab). */
  newEpisodes: number;
  attribution: string;
  onSelect: (id: MenuId) => void;
}

function useNavContainer(active: MenuId | null, boundary: ("up" | "down" | "left" | "right")[]) {
  return useFocusable({
    focusKey: "menu",
    trackChildren: true,
    preferredChildFocusKey: `menu-${active ?? "home"}`,
    isFocusBoundary: true,
    focusBoundaryDirections: boundary,
  });
}

function NavItem({ id, onPress, className, children }: { id: MenuId; onPress: () => void; className?: (focused: boolean) => string; children: (focused: boolean) => ReactNode }) {
  const { ref, focused } = useFocusable({ focusKey: `menu-${id}`, onEnterPress: onPress });
  return (
    <div ref={ref} role="button" tabIndex={-1} data-menu={id} data-nav-focused={focused ? "1" : undefined} onClick={onPress} className={className?.(focused) ?? ""}>
      {children(focused)}
    </div>
  );
}

// ================================================================ Кинозал

/** Left icon rail that expands with labels while focused (fixed rail width, so geometry never changes). */
export function KinozalRail({ active, profile, unread, newEpisodes, attribution, onSelect }: NavProps) {
  const { t } = useI18n();
  const { ref, focusKey, hasFocusedChild: open } = useNavContainer(active, ["up", "down", "left"]);
  const all: Partial<Record<MenuId, { label: string; icon: ReactNode; badge?: number }>> = {
    search: { label: t("catalog.search"), icon: <SearchIcon /> },
    home: { label: t("nav.home"), icon: <HomeIcon /> },
    tv: { label: t("iptv.title"), icon: <LiveTvIcon /> },
    video: { label: t("video.title"), icon: <PlayTileIcon /> },
    explore: { label: t("nav.explore"), icon: <CompassIcon /> },
    movies: { label: t("catalog.movies"), icon: <FilmIcon /> },
    series: { label: t("catalog.series"), icon: <TvIcon /> },
    new: { label: t("newep.title"), icon: <NewEpisodesIcon />, badge: newEpisodes },
    surprise: { label: t("nav.surprise"), icon: <DiceIcon /> },
    ask: { label: t("nav.ask"), icon: <SparkIcon /> },
    history: { label: t("nav.history"), icon: <ClockIcon /> },
    mine: { label: t("tvd.nav.mine"), icon: <BookmarkIcon /> },
    messages: { label: t("tvd.nav.messages"), icon: <MessageIcon />, badge: unread },
  };
  const ids = visibleMenu(KINOZAL_MENU, useServerFeatures());
  const top = ids.map((id) => ({ id, ...all[id]! }));
  const indicator = railIndicatorTop(active, ids);
  const item = (it: { id: MenuId; label: string; icon: ReactNode; badge?: number; sub?: string }) => (
    <NavItem
      key={it.id}
      id={it.id}
      onPress={() => onSelect(it.id)}
      className={(f) =>
        `k-rail-item relative mb-[4px] flex h-[54px] items-center rounded-control ${open ? "w-[400px]" : "w-[62px]"} ${
          f ? "k-rail-focus bg-text text-bg" : active === it.id ? "k-rail-active text-text" : "text-muted"
        }`
      }
    >
      {(f) => (
        <>
          <span className="relative flex h-[54px] w-[62px] shrink-0 items-center justify-center">
            {it.icon}
            {!!it.badge && (
              <span
                data-testid={it.id === "new" ? "new-episodes-badge" : undefined}
                className="absolute right-[6px] top-[2px] min-w-[24px] rounded-full bg-accent px-1.5 text-center text-[16px] font-bold leading-[24px] text-on-accent"
              >
                {it.badge > 9 ? "9+" : it.badge}
              </span>
            )}
          </span>
          {open && (
            <span className="ml-3 min-w-0">
              <span className="block truncate text-[27px] font-medium">{it.label}</span>
              {it.sub && <span className={`block truncate text-[19px] ${f ? "text-bg" : "text-muted"}`}>{it.sub}</span>}
            </span>
          )}
        </>
      )}
    </NavItem>
  );
  return (
    <FocusContext.Provider value={focusKey}>
      <nav ref={ref} data-design-nav="kinozal" className="absolute left-0 top-0 z-20 h-full" style={{ width: RAIL_W }}>
        <div className="absolute left-0 top-0 h-full w-full bg-bg" />
        <div className={`tv-menu-panel absolute left-0 top-0 h-full w-[560px] ${open ? "opacity-100" : "opacity-0"}`} />
        {indicator !== null && !open && <span className="absolute left-0 w-[5px] rounded-r bg-accent" style={{ top: indicator, height: 32 }} />}
        <div className="relative flex h-full flex-col pb-9 pl-[25px] pt-[54px]">
          <div className="mb-[28px] flex h-[54px] w-[62px] items-center">
            <Mascot size={58} animated={false} />
          </div>
          <div>{top.map(item)}</div>
          <div className="mt-auto">
            {item({ id: "settings", label: t("settings.title"), icon: <SlidersIcon /> })}
            <NavItem
              id="profile"
              onPress={() => onSelect("profile")}
              className={(f) => `k-rail-item relative flex h-[62px] items-center rounded-control ${open ? "w-[400px]" : "w-[62px]"} ${f ? "k-rail-focus bg-text text-bg" : ""}`}
            >
              {(f) => (
                <>
                  <span className="flex h-[62px] w-[62px] shrink-0 items-center justify-center">
                    <ProfileAvatar name={profile.name} color={profile.color} avatar={profile.avatar} size={52} className="rounded-full" />
                  </span>
                  {open && (
                    <span className="ml-3 min-w-0">
                      <span className="block truncate text-[27px] font-medium">{profile.name}</span>
                      <span className={`block truncate text-[19px] ${f ? "text-bg" : "text-muted"}`}>{t("tv.switch_profile")}</span>
                    </span>
                  )}
                </>
              )}
            </NavItem>
            {open && <p className="mt-6 w-[400px] text-[17px] leading-snug text-muted">{attribution}</p>}
          </div>
        </div>
      </nav>
    </FocusContext.Provider>
  );
}

/** Top-right: `<TV> · TorrServer онлайн` with a status dot, and the clock. */
export function StatusCorner({ className = "" }: { className?: string }) {
  const { t } = useI18n();
  const device = useDevice();
  const status = useServerStatus();
  const now = useClock();
  const st = torrState(status.data);
  const label = st === "online" ? t("tvd.status.online") : st === "offline" ? t("tvd.status.offline") : t("tvd.status.checking");
  return (
    <div data-testid="status-corner" data-torrserver={st} className={`tv-key-hint flex items-center rounded-full py-2 pl-5 pr-6 ${className}`}>
      <span className={`mr-3 inline-block h-[12px] w-[12px] rounded-full ${st === "online" ? "bg-ok" : st === "offline" ? "bg-danger" : "bg-muted"}`} />
      <span className="text-[22px] text-text/75">
        {device ? `${device.name} · ` : ""}
        {label}
      </span>
      <span className="ml-8 text-[26px] font-bold text-text">{clockText(now)}</span>
    </div>
  );
}

// ================================================================ Терминал

export function TerminalBar({ active, profile, unread, mine, newEpisodes, onSelect }: NavProps) {
  const { t, locale } = useI18n();
  const now = useClock();
  const { ref, focusKey } = useNavContainer(active, ["up", "left", "right"]);
  const labels: Partial<Record<MenuId, { label: string; count?: number | null }>> = {
    home: { label: t("nav.home") },
    tv: { label: t("iptv.title") },
    video: { label: t("video.title") },
    explore: { label: t("nav.explore") },
    movies: { label: t("catalog.movies") },
    series: { label: t("catalog.series") },
    new: { label: t("newep.short"), count: newEpisodes || null },
    search: { label: t("catalog.search") },
    surprise: { label: t("fy.tv.surprise_short") },
    ask: { label: t("ask.tv.short") },
    history: { label: t("nav.history") },
    mine: { label: t("tvd.nav.mine"), count: mine },
    messages: { label: t("tvd.nav.messages"), count: unread || null },
  };
  // «Конструктивизм» renames a few tabs (visible text only: data-menu / focus keys stay).
  const cvOn = useAppliedDesign() === "constructivism";
  const cv = cvOn && locale === "ru";
  const tabs = visibleMenu(TERMINAL_MENU, useServerFeatures()).map((id) => ({ id, ...labels[id]!, label: cvMenuLabel(cv, id, labels[id]!.label) }));
  const tab = (id: MenuId, children: ReactNode, extra = "") => (
    <NavItem
      key={id}
      id={id}
      onPress={() => onSelect(id)}
      className={(f) => `t-tab relative mr-[2px] flex h-[52px] items-center px-[6px] ${f ? "bg-text text-bg" : active === id ? "text-text" : "text-muted"} ${extra}`}
    >
      {(f) => (
        <>
          {children}
          {active === id && !f && <span className="absolute bottom-0 left-[6px] right-[6px] h-[3px] bg-accent" />}
        </>
      )}
    </NavItem>
  );
  return (
    <FocusContext.Provider value={focusKey}>
      <nav ref={ref} data-design-nav="terminal" className="absolute left-0 top-0 z-20 flex w-full items-center pl-[96px] pr-[48px] pt-[34px]" style={{ height: 132 }}>
        <span className="mr-[16px] font-display text-[31px] font-extrabold tracking-tight text-text">
          CINEKO<span className="text-accent">/</span>TV
        </span>
        {/* 12 tabs at 22 px (legible on 720p panels): the screen titles keep the «02 /» numbering, the bar drops it so it fits 1920 with ⚙, the profile and the clock. */}
        <div className="t-label flex items-center text-[22px]" style={{ letterSpacing: ".03em" }}>
          {tabs.map((x) =>
            tab(
              x.id,
              <span className="whitespace-nowrap">
                {x.label}
                {x.count ? (
                  <span data-testid={x.id === "new" ? "new-episodes-badge" : undefined} className="text-accent">
                    {" "}
                    [{x.count}]
                  </span>
                ) : null}
              </span>,
            ),
          )}
        </div>
        <div className="t-label ml-auto flex items-center text-[22px]">
          {tab("settings", cvOn ? <CvIcon glyph="gear" width={28} height={28} className="block" /> : <span>⚙</span>)}
          {tab("profile", <span className="block max-w-[170px] truncate whitespace-nowrap">{profile.name}</span>)}
          <span className="ml-[16px] font-mono text-[24px] text-text">{clockText(now)}</span>
        </div>
      </nav>
    </FocusContext.Provider>
  );
}

/** Bottom status line: orange bar, mono caps, scrolling slowly (transform only). */
export function TerminalTicker({ profile, unread }: { profile: Profile; unread: number }) {
  const { t } = useI18n();
  const plural = usePlural();
  const device = useDevice();
  const status = useServerStatus();
  const items = tickerItems({
    device: device?.name ?? null,
    status: status.data,
    profile: profile.name,
    unread,
    labels: {
      online: t("tvd.ticker.online"),
      offline: t("tvd.status.offline"),
      torrserver: (ms) => t("tvd.ticker.torrserver", { ms: ms ?? "—" }),
      torrserverDown: t("tvd.ticker.torrserver_down"),
      prowlarrDown: t("tvd.ticker.prowlarr_down"),
      streams: (n) => plural("tvd.ticker.streams", n),
      profile: (name) => t("tvd.nav.profile", { name }),
      unread: (n) => plural("tvd.ticker.unread", n),
    },
  });
  // Non-breaking gaps: plain spaces would collapse.
  const text = items.join("\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0");
  return (
    <div data-testid="status-ticker" className="absolute bottom-0 left-0 z-20 h-[44px] w-full overflow-hidden bg-accent text-on-accent">
      <div className="t-ticker-track absolute left-0 top-0 flex h-full items-center whitespace-nowrap font-mono text-[19px] font-medium tracking-[.08em]" style={{ animationDuration: `${tickerSeconds(text) * 2}s` }}>
        {/* Two copies: the strip moves by half its width, then repeats seamlessly. */}
        <span className="pl-[96px] pr-[120px]">{text}</span>
        <span className="pl-[96px] pr-[120px]">{text}</span>
      </div>
    </div>
  );
}

// ================================================================ Проектор

export function ProjectorBar({ active, profile, unread, newEpisodes, onSelect }: NavProps) {
  const { t } = useI18n();
  const now = useClock();
  const { ref, focusKey, hasFocusedChild } = useNavContainer(active, ["up", "left", "right"]);
  const text: Partial<Record<MenuId, string>> = {
    home: t("nav.home"),
    tv: t("iptv.title"),
    video: t("video.title"),
    explore: t("nav.explore"),
    movies: t("catalog.movies"),
    series: t("catalog.series"),
    history: t("nav.history"),
    mine: t("tvd.nav.mine"),
  };
  // «Каркас» draws its own synthwave set on this skeleton.
  const wave = useSkin() === "wireframe";
  const icons: Partial<Record<MenuId, ReactNode>> = {
    new: (
      <span className="relative inline-flex">
        {wave ? <WaveNewIcon /> : <NewEpisodesIcon size={28} stroke={2} />}
        {newEpisodes > 0 && (
          <span
            data-testid="new-episodes-badge"
            className="absolute -right-[12px] -top-[10px] min-w-[22px] rounded-full bg-accent px-[5px] text-center text-[15px] font-bold leading-[22px] text-on-accent"
          >
            {newEpisodes > 9 ? "9+" : newEpisodes}
          </span>
        )}
      </span>
    ),
    ask: wave ? <WaveAskIcon /> : <SparkIcon size={28} stroke={2} />,
    surprise: wave ? <WaveDiceIcon /> : <DiceIcon size={28} stroke={2} />,
    search: wave ? <WaveSearchIcon /> : <SearchIcon size={28} stroke={2.2} />,
    messages: (
      <span className="relative inline-flex">
        {wave ? <WaveMessageIcon /> : <MessageIcon size={28} stroke={2} />}
        {unread > 0 && <span className="absolute -right-1 -top-1 h-[12px] w-[12px] rounded-full bg-accent" />}
      </span>
    ),
    settings: wave ? <WaveSlidersIcon /> : <SlidersIcon size={28} stroke={2} />,
  };
  // «Каркас»: every text tab gets its icon too (icon + label).
  const tabIcon: Partial<Record<MenuId, ReactNode>> = wave
    ? {
        home: <WaveHomeIcon size={26} />,
        tv: <WaveLiveIcon size={26} />,
        video: <WaveVideoIcon size={26} />,
        explore: <WaveExploreIcon size={26} />,
        movies: <WaveFilmIcon size={26} />,
        series: <WaveSeriesIcon size={26} />,
        history: <WaveHistoryIcon size={26} />,
        mine: <WaveMineIcon size={26} />,
      }
    : {};
  const labelOf = (id: MenuId): ReactNode =>
    tabIcon[id] ? (
      <span className="flex items-center gap-[8px]">
        {tabIcon[id]}
        {text[id]}
      </span>
    ) : (
      text[id]
    );
  // A 3 px gap between tabs: without it, rounding on scaled screens could make
  // neighbours overlap by a pixel, and the focus engine (which only moves to a
  // tab starting after the current one ends) skipped «Видео» / «ТВ».
  const features = useServerFeatures();
  const tabs: { id: MenuId; label: ReactNode; icon: boolean }[] = [
    ...visibleMenu(PROJECTOR_TEXT, features).map((id) => ({ id, label: labelOf(id), icon: false })),
    ...PROJECTOR_ICONS.map((id) => ({ id, label: icons[id], icon: true })),
  ];
  return (
    <FocusContext.Provider value={focusKey}>
      <nav ref={ref} data-design-nav="projector" className="absolute left-0 top-0 z-20 w-full" style={{ height: 132 }}>
        <div className="p-scrim-top absolute left-0 top-0 h-[200px] w-full" />
        <div className="absolute left-0 top-[58px] flex w-full justify-center">
          <div className="p-bar flex h-[66px] items-center rounded-full px-[6px]">
            {tabs.map((x) => (
              <NavItem
                key={x.id}
                id={x.id}
                onPress={() => onSelect(x.id)}
                className={(f) =>
                  `p-tab tv-focus tv-flat mr-[3px] flex h-[54px] items-center rounded-full last:mr-0 ${x.icon ? (wave ? "px-[10px]" : "px-[16px]") : wave ? "px-[10px]" : "px-[21px]"} ${wave ? "text-[22px]" : "text-[25px]"} font-medium ${
                    f ? "is-focused bg-white text-black" : active === x.id ? (hasFocusedChild ? "p-tab-on bg-white/20 text-white" : "p-tab-on bg-white text-black") : "text-white/85"
                  }`
                }
              >
                {() => x.label}
              </NavItem>
            ))}
          </div>
        </div>
        <div className="absolute right-[96px] top-[64px] flex items-center">
          <span className="mr-6 text-[25px] font-medium text-white">{clockText(now)}</span>
          <NavItem id="profile" onPress={() => onSelect("profile")} className={(f) => `tv-focus rounded-full ${f ? "is-focused" : ""}`}>
            {() => <ProfileAvatar name={profile.name} color={profile.color} avatar={profile.avatar} size={54} className="rounded-full" />}
          </NavItem>
        </div>
      </nav>
    </FocusContext.Provider>
  );
}

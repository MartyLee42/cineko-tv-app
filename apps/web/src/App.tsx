import { useEffect, useRef, useState, type ReactNode } from "react";
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate, useNavigationType } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { isAdminRole } from "@martytv/contracts";
import { Centered, cvMenuLabel, Logo, Spinner, useConstructivism, useI18n } from "@martytv/ui";
import { api, realtime, setCsrfToken } from "./api";
import { useSession } from "./session";
import { Button, ErrorText } from "./components";
import { LoginPage } from "./pages/LoginPage";
import { PillLayer } from "./matrix/PillDialog";
import { HomePage } from "./pages/HomePage";
import { PairPage } from "./pages/PairPage";
import { DevicesPage } from "./pages/DevicesPage";
import { TvSettingsPage } from "./devsettings/TvSettingsPage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ListPage } from "./pages/ListPage";
import { HistoryPage } from "./pages/HistoryPage";
import { AdminPage } from "./pages/AdminPage";
import { BrowsePage } from "./pages/BrowsePage";
import { SearchPage } from "./pages/SearchPage";
import { PersonPage } from "./pages/PersonPage";
import { TitlePage } from "./pages/TitlePage";
import { RemoteIndex, RemotePage } from "./pages/RemotePage";
import { WatchPage } from "./player/WatchPage";
import { NowOnTvBar } from "./remote/NowOnTv";
import { useRealtimeCache } from "./remote/state";
import { clearCatalogCaches } from "./catalog/cache";
import { BellIcon, GearIcon, HistoryIcon, HomeIcon, PlayIcon, SearchIcon, TvIcon } from "./icons";
import { ActiveProfileProvider } from "./watch/ActiveProfile";
import { InboxButton, MessageToast, ProfileMenu, useMessageEvents } from "./watch/header";
import { useSettings, useThemeSync } from "./watch/queries";
import type { Settings } from "./watch/settings";
import { OnboardingGate } from "./watch/Onboarding";
import { RecoHeaderButton } from "./reco/header";
import { RecommendationsPage } from "./reco/RecommendationsPage";
import { ExplorePage, ExploreTilePage } from "./foryou/ExplorePage";
import { CollectionPage } from "./foryou/CollectionPage";
import { CuratedListPage, CuratedShelfPage } from "./foryou/CuratedPage";
import { SurprisePage } from "./foryou/SurprisePage";
import { AskPage, SparkIcon } from "./foryou/AskPage";
import { DiaryPage } from "./foryou/DiaryPage";
import { TastePage } from "./foryou/TastePage";
import { NotesPage } from "./foryou/NotesPage";
import { CompassIcon } from "./foryou/icons";
import { TvChannelsPage } from "./iptv/TvChannelsPage";
import { VideoPage } from "./video/VideoPage";
import { WatchVideoPage } from "./video/WatchVideoPage";
import { VideoChannelPage } from "./video/ChannelPage";
import { useForYouRealtime } from "./foryou/queries";
import { DownloadsPage } from "./pages/DownloadsPage";
import { NewEpisodesPage } from "./newepisodes/NewEpisodesPage";
import { TasteQuizPage } from "./tastequiz/TasteQuizPage";
import { useDownloadsRealtime } from "./downloads/queries";
import { WebSeasonLayer } from "./seasons/SeasonalLayer";
import { WebCozyLayer } from "./cozy/WebCozyLayer";
import { ClientPrefsAgent } from "./devprefs/ui";
import { OfflinePlayerPage, OfflineScreen } from "./offline/ui";
import { looksOffline } from "./offline/device";

/**
 * A new page (a title, a person, another tab…) opens at the top instead of
 * at the previous page's scroll. Back/forward keep the browser's restored
 * position; query-only changes (filters, tabs inside a page) don't scroll.
 */
function ScrollToTop() {
  const { pathname } = useLocation();
  const type = useNavigationType();
  // Only a new path scrolls. A query change on the same page (picking a
  // season replaces ?season=…) flips the type PUSH → REPLACE, which used to
  // re-run this and jump to the top.
  const last = useRef(pathname);
  useEffect(() => {
    if (last.current === pathname) return;
    last.current = pathname;
    if (type !== "POP") window.scrollTo(0, 0);
  }, [pathname, type]);
  return null;
}

export function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <PillLayer />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* Plays a video saved on this device: works with no connection. */}
        <Route path="/offline/:id" element={<OfflinePlayerPage />} />
        <Route element={<RequireAuth />}>
          {/* Full-screen player: no header / tab bar. */}
          <Route path="watch/:sourceId" element={<WatchPage />} />
          <Route element={<Layout />}>
            <Route index element={<HomePage />} />
            <Route path="browse" element={<BrowsePage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="title/:id" element={<TitlePage />} />
            <Route path="person/:tmdbId" element={<PersonPage />} />
            <Route path="pair" element={<PairPage />} />
            <Route path="devices" element={<DevicesPage />} />
            <Route path="devices/:id/settings" element={<TvSettingsPage />} />
            <Route path="remote" element={<RemoteIndex />} />
            <Route path="remote/:deviceId" element={<RemotePage />} />
            <Route path="profiles" element={<ProfilesPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="account" element={<Navigate to="/settings#account" replace />} />
            <Route path="lists/:list" element={<ListPage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="new-episodes" element={<NewEpisodesPage />} />
            <Route path="recommendations" element={<RecommendationsPage />} />
            <Route path="explore" element={<ExplorePage />} />
            <Route path="explore/:tile" element={<ExploreTilePage />} />
            <Route path="collections/:id" element={<CollectionPage />} />
            <Route path="curated" element={<CuratedShelfPage />} />
            <Route path="curated/:id" element={<CuratedListPage />} />
            <Route path="surprise" element={<SurprisePage />} />
            <Route path="ask" element={<AskPage />} />
            <Route path="diary" element={<DiaryPage />} />
            <Route path="taste" element={<TastePage />} />
            <Route path="taste-quiz" element={<TasteQuizPage />} />
            <Route path="notes" element={<NotesPage />} />
            <Route path="downloads" element={<DownloadsPage />} />
            <Route path="tv-channels" element={<TvChannelsPage />} />
            <Route path="video" element={<VideoPage />} />
            <Route path="video/watch/:id" element={<WatchVideoPage />} />
            <Route path="video/channel/:id" element={<VideoChannelPage />} />
            <Route path="admin" element={<AdminPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

/** Sends signed-out visitors to /login, remembering where they were going. */
function RequireAuth() {
  const { data: session, isPending, error, refetch } = useSession();
  const location = useLocation();
  const { t } = useI18n();
  useRealtimeSync(!!session);
  useMessageEvents(!!session);
  useForYouRealtime(!!session, location.pathname, location.search);
  useDownloadsRealtime(!!session);

  if (isPending) {
    return (
      <Centered>
        <Spinner />
      </Centered>
    );
  }
  if (error && looksOffline(error)) {
    // No connection (or the server is down): downloads and offline music still work.
    return <OfflineScreen onRetry={() => void refetch()} />;
  }
  if (error) {
    return (
      <Centered>
        <ErrorText error={error} />
        <Button className="mt-4" onClick={() => refetch()}>
          {t("common.retry")}
        </Button>
      </Centered>
    );
  }
  if (!session) {
    const next = location.pathname + location.search;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return (
    <ActiveProfileProvider key={session.user.id}>
      <Outlet />
    </ActiveProfileProvider>
  );
}

/** Keeps the realtime socket open while signed in; events update device data and live TV state. */
function useRealtimeSync(enabled: boolean) {
  const qc = useQueryClient();
  useRealtimeCache(qc, enabled);
  useEffect(() => {
    if (!enabled) return;
    realtime.start();
    return () => realtime.stop();
  }, [enabled]);
}

function Layout() {
  const { t, locale } = useI18n();
  useThemeSync();
  const { data: session } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // The remote belongs to Devices; Browse / tiles / collections / Surprise to Explore; Diary / Taste to History.
  const active = (to: string, isActive: boolean) => isActive || navSection(pathname) === to;
  const isAdmin = isAdminRole(session?.user.role);

  const logout = async () => {
    await api.POST("/auth/logout");
    setCsrfToken(undefined);
    qc.clear();
    await clearCatalogCaches();
    navigate("/login", { replace: true });
  };

  // «Конструктивизм» renames a few menu items (visible text only; routes, test ids and aria labels stay).
  const cv = useConstructivism() && locale === "ru";
  /** Label + the original as the accessible name (so names, tests and screen readers stay the same). */
  const cvl = (id: string, label: string) => ({ label: cvMenuLabel(cv, id, label), ...(cv && cvMenuLabel(cv, id, label) !== label ? { aria: label } : {}) });
  // Tabs the profile hid in Settings → «Вкладки меню».
  const hidden = new Set<string>(useSettings().hidden_tabs ?? []);
  const shown = <T extends { tab?: NavTab }>(l: T) => !l.tab || !hidden.has(l.tab);
  // Desktop tabs: the main sections only. Search is an icon on the right;
  // Devices, Settings and Admin live in the avatar menu. Narrower screens
  // move the tail tabs into «Ещё» (`from` = the breakpoint they appear inline).
  const topLinks: TopLink[] = [
    { to: "/", ...cvl("home", t("nav.home")) },
    { to: "/tv-channels", label: t("iptv.title"), tab: "tv" as const },
    { to: "/video", label: t("video.title"), tab: "video" as const },
    { to: "/explore", label: t("nav.explore"), tab: "explore" as const },
    { to: "/new-episodes", label: t("newep.title"), icon: <BellIcon />, from: "lg" as const, tab: "new" as const },
    { to: "/history", ...cvl("history", t("nav.history")), icon: <HistoryIcon />, from: "lg" as const, tab: "history" as const },
    { to: "/ask", ...cvl("ask", t("nav.ask")), icon: <SparkIcon />, from: "xl" as const, tab: "ask" as const },
  ].filter(shown);
  // The phone bottom bar keeps 5 items: Home, the first three shown tabs, Settings.
  // Devices and Admin are one tap away in Settings (and the avatar menu).
  const bottomLinks = [
    { to: "/", ...cvl("home", t("nav.home")), icon: <HomeIcon /> },
    ...[
      { to: "/explore", label: t("nav.explore"), icon: <CompassIcon />, tab: "explore" as const },
      { to: "/search", ...cvl("search", t("catalog.search")), icon: <SearchIcon />, tab: "search" as const },
      { to: "/history", ...cvl("history", t("nav.history")), icon: <HistoryIcon />, tab: "history" as const },
      { to: "/tv-channels", label: t("iptv.title"), icon: <TvIcon />, tab: "tv" as const },
      { to: "/video", label: t("video.title"), icon: <PlayIcon />, tab: "video" as const },
      { to: "/new-episodes", label: t("newep.title"), icon: <BellIcon />, tab: "new" as const },
    ]
      .filter(shown)
      .slice(0, 3),
    { to: "/settings", ...cvl("settings", t("settings.title")), icon: <GearIcon /> },
  ];

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-border bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <NavLink to="/" className="shrink-0 text-xl">
            <Logo />
          </NavLink>
          <nav className="hidden items-center gap-1 md:flex">
            {topLinks.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                aria-label={l.aria}
                end={l.to === "/"}
                className={({ isActive }) =>
                  `${l.from === "lg" ? "hidden lg:block" : l.from === "xl" ? "hidden xl:block" : ""} whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm font-medium ${active(l.to, isActive) ? "bg-surface-2 text-text" : "text-muted hover:text-text"}`
                }
              >
                {l.label}
              </NavLink>
            ))}
            {topLinks.some((l) => l.from) && <MoreMenu links={topLinks.filter((l) => l.from)} active={(to) => active(to, pathname.startsWith(to))} />}
          </nav>
          <div className="ml-auto flex items-center gap-1.5 text-sm">
            {!hidden.has("search") && (
            <NavLink
              to="/search"
              aria-label={t("catalog.search")}
              title={t("catalog.search")}
              className={({ isActive }) =>
                `hidden h-10 w-10 items-center justify-center rounded-full text-xl hover:bg-surface-2 hover:text-text md:flex ${isActive ? "bg-surface-2 text-text" : "text-muted"}`
              }
            >
              <SearchIcon />
            </NavLink>
            )}
            {/* Cineko Music: a separate app at /music (full page load, not a route). */}
            <a
              href="/music/"
              aria-label={t("nav.music")}
              title={t("nav.music")}
              className="flex h-10 w-10 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-text"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M9 17.5V6.2a1 1 0 0 1 .76-.97l9-2.25A1 1 0 0 1 20 3.95v11.3a3 3 0 1 1-2-2.83V7.03l-7 1.75v8.72A3 3 0 1 1 9 17.5z" />
              </svg>
            </a>
            <RecoHeaderButton />
            <InboxButton />
            <ProfileMenu userName={session?.user.display_name || session?.user.username || ""} onLogout={logout} isAdmin={isAdmin} />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-24 pt-6 md:pb-10">
        {/* A new page fades in (opacity + a few px: cheap, compositor-only) and
            keeps a screen's height while its data loads, so the footer and
            the bottom bar's surroundings don't jump. */}
        <div key={pathname} className="mt-page min-h-[calc(100dvh-10rem)]">
          <Outlet />
        </div>
        <NowOnTvBar />
      </main>
      <MessageToast />
      <WebCozyLayer />
      <WebSeasonLayer />
      <OnboardingGate />
      <ClientPrefsAgent />
      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {bottomLinks.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            aria-label={"aria" in l ? l.aria : undefined}
            end={l.to === "/"}
            className={({ isActive }) =>
              `flex min-h-[52px] min-w-0 flex-1 flex-col items-center justify-center gap-1 py-1.5 text-[11px] font-medium ${active(l.to, isActive) || (l.to === "/settings" && (pathname.startsWith("/devices") || navSection(pathname) === "/devices")) || (l.to === "/" && pathname.startsWith("/video")) ? "text-accent" : "text-muted"}`
            }
          >
            <span className="text-[22px] leading-none">{l.icon}</span>
            <span className="max-w-full truncate px-0.5">{l.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

type NavTab = NonNullable<Settings["hidden_tabs"]>[number];
type TopLink = { to: string; label: string; aria?: string; icon?: ReactNode; from?: "lg" | "xl"; tab?: NavTab };

/** «Ещё ▾»: the desktop tabs that don't fit inline at this width. */
function MoreMenu({ links, active }: { links: TopLink[]; active: (to: string) => boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  // Inline from lg → in the menu only below lg; the menu itself goes at xl.
  const hiddenAt = (l: TopLink) => (l.from === "lg" ? "lg:hidden" : "");
  const on = links.some((l) => active(l.to));
  return (
    <div ref={root} className="relative xl:hidden">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="nav-more"
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm font-medium ${on ? "text-text" : "text-muted hover:text-text"}`}
      >
        {t("nav.more")}
        <span aria-hidden className="text-[10px]">▾</span>
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-[calc(100%+0.5rem)] z-40 w-60 rounded-2xl border border-border bg-surface p-2 shadow-2xl shadow-black/30">
          {links.map((l) => (
            <NavLink
              key={l.to}
              role="menuitem"
              to={l.to}
              aria-label={l.aria}
              onClick={() => setOpen(false)}
              className={`${hiddenAt(l)} flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 text-sm hover:bg-surface-2 ${active(l.to) ? "bg-surface-2 font-semibold" : ""}`}
            >
              <span className="w-6 text-center text-lg text-muted">{l.icon}</span>
              {l.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

/** Which nav item a page belongs to (besides its own path). */
export function navSection(pathname: string): string | null {
  if (pathname.startsWith("/remote") || pathname.startsWith("/pair")) return "/devices";
  if (/^\/(browse|explore|collections|curated|surprise)(\/|$)/.test(pathname)) return "/explore";
  if (/^\/(diary|taste)(\/|$)/.test(pathname)) return "/history";
  if (/^\/downloads(\/|$)/.test(pathname)) return "/settings";
  return null;
}

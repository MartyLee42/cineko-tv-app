import { Suspense, useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { navigateByDirection } from "@noriginmedia/norigin-spatial-navigation";
import type { ContinueItem, Episode, IptvChannel, MediaDetail, MediaSummary, Profile, Release } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";
import { FocusRecorderProvider, FocusSection, getCurrentFocusKey, rememberFocus, setFocus } from "../../focus";
import { runToTop, setBackFirst, useDeep } from "../../design/topJump";
import { playerKey } from "../../player/keys";
import { openSection, push, type Route, type StackEntry } from "../../catalog/nav";
import { useCatalogConfig } from "../../catalog/queries";
import { FRAMES, useDesign, useSkin } from "../../design/context";
import { SkinBackground } from "../../design/skins";
import { useInbox, useWatchlist } from "../../design/data";
import { KinozalRail, ProjectorBar, TerminalBar, TerminalTicker, type MenuId, type NavProps } from "../../design/shell";
import { HomeCatalog } from "./HomeCatalog";
import { TvIdleLayer } from "../../idle/IdleLayer";
import { CvQueue } from "../../design/cvHome";
import { useNewEpisodesUnseen, type NewEpisodeItem } from "../../newepisodes/data";
import { QuizInvite } from "../../taste/QuizInvite";
import type { VideoItem } from "../../video/logic";
import type { DetailsInfo } from "../../remote/state";
import { useSettingsQuery } from "../../profile/settings";
import { TvCozyLayer } from "../../design/cozy";
import { TvSeasonLayer } from "../../design/season";
import {
  AskScreen,
  BrowseScreen,
  CollectionScreen,
  CuratedScreen,
  DetailsScreen,
  ExploreScreen,
  HistoryScreen,
  MessagesScreen,
  MineScreen,
  NewEpisodesScreen,
  Onboarding,
  PersonScreen,
  prefetchDetails,
  prefetchLater,
  prefetchMenu,
  ScreenWait,
  SearchScreen,
  SettingsScreen,
  SurpriseScreen,
  TasteQuiz,
  TileScreen,
  TvChannelsScreen,
  TvDayScreen,
  VideoChannelScreen,
  VideoScreen,
  VideoSearchScreen,
} from "../../lazy";

/** The «▲ К вкладкам» hint was shown in this app run. */
let hintShown = false;

/** How Details starts playback: the release picker, the best match (searched now), or a given release. */
/** The picker, the best release, a release, or (resume) the source last watched with. */
export type PlayHow = "pick" | "best" | Release | { source_id: string };

function menuFor(route: Route): MenuId | null {
  switch (route.name) {
    case "home":
      return "home";
    case "tv":
    case "tv-day":
      return "tv";
    case "video":
    case "video-search":
    case "video-channel":
      return "video";
    case "search":
      return "search";
    case "mine":
      return "mine";
    case "messages":
      return "messages";
    case "browse":
      return route.kind === "movie" ? "movies" : "series";
    case "explore":
    case "tile":
    case "collection":
    case "curated":
      return "explore";
    case "surprise":
      return "surprise";
    case "ask":
      return "ask";
    case "history":
      return "history";
    case "new-episodes":
      return "new";
    default:
      return null;
  }
}

const sectionRoute: Record<Exclude<MenuId, "profile" | "settings">, Route> = {
  home: { name: "home" },
  tv: { name: "tv" },
  video: { name: "video" },
  search: { name: "search" },
  mine: { name: "mine" },
  messages: { name: "messages" },
  movies: { name: "browse", kind: "movie" },
  series: { name: "browse", kind: "series" },
  explore: { name: "explore" },
  surprise: { name: "surprise" },
  ask: { name: "ask" },
  history: { name: "history" },
  new: { name: "new-episodes" },
};

/**
 * Signed-in area: side menu + the top screen of the stack. Each screen is
 * keyed by its stack entry, so it remounts when shown again and restores
 * itself (focus, scroll, query…) from the entry's memory.
 */
/** Runs `fn` once the focus engine has moved focus into the menu (≤ ~0.5 s). */
function afterMenuFocus(fn: () => void, tries = 30) {
  if ((getCurrentFocusKey() ?? "").startsWith("menu") || tries <= 0) return void fn();
  requestAnimationFrame(() => afterMenuFocus(fn, tries - 1));
}

export function CatalogShell({
  profile,
  stack,
  setStack,
  onBack,
  onSwitchProfile,
  onDetailsInfo,
  onPlay,
  onContinue,
  onLive,
  onVideo,
}: {
  profile: Profile;
  stack: StackEntry[];
  setStack: Dispatch<SetStateAction<StackEntry[]>>;
  onBack: () => void;
  onSwitchProfile: () => void;
  /** Details on top reported its title/season (for device.state). */
  onDetailsInfo?: (entryKey: number, info: DetailsInfo) => void;
  /** Play from the Details on top (picker, or best release with `best`). */
  onPlay?: (entry: StackEntry, media: MediaDetail, episode: Episode | null, how: PlayHow, startAt?: number) => void;
  /** OK on a "Continue watching" card: resume right away. */
  onContinue?: (entry: StackEntry, item: ContinueItem) => void;
  /** Live TV: play a channel (Up/Down switch through `list`). */
  onLive?: (channel: IptvChannel, list: IptvChannel[]) => void;
  /** «Видео»: play a YouTube video from `start` (null = its resume position). */
  onVideo?: (video: VideoItem, start: number | null) => void;
}) {
  const [settings, setSettings] = useState(false);
  // «Давайте определим ваш вкус» (taste/TasteQuiz.tsx), from the Home invitation.
  const [quiz, setQuiz] = useState(false);
  // First-run guide until the profile completed (or skipped) it anywhere.
  const sq = useSettingsQuery();
  const [guideDone, setGuideDone] = useState<string | null>(null);
  const guide = !!sq.data && sq.data.onboarding_completed !== true && guideDone !== profile.id;
  const { t } = useI18n();
  const cfg = useCatalogConfig();
  const top = stack[stack.length - 1]!;
  const { mem } = top;

  const design = useDesign();
  const skin = useSkin();
  const frame = FRAMES[design];
  const inbox = useInbox();
  const unread = inbox.data?.unread ?? 0;
  const watchlist = useWatchlist();
  const newEpisodes = useNewEpisodesUnseen();

  /** Opens Details; `from` names the row/section it was opened from (back hint, breadcrumb). */
  const open = (item: MediaSummary, from?: string, at?: { season: number; episode: number } | null) => {
    rememberFocus(mem);
    setStack((s) => push(s, { name: "details", id: item.id, preview: item, ...(from ? { from } : {}), ...(at ? { season: at.season, episode: at.episode } : {}) }));
  };

  const onMenu = (id: MenuId) => {
    if (id === "settings") {
      setSettings(true);
      return;
    }
    if (id === "profile") {
      rememberFocus(mem);
      onSwitchProfile();
      return;
    }
    const next = openSection(stack, sectionRoute[id]);
    if (next === stack) setFocus(`content-${top.key}`);
    else setStack(next);
  };

  const record = useCallback((focusKey: string) => mem.set("focusKey", focusKey), [mem]);
  const topKey = top.key;
  const reportInfo = useCallback((info: DetailsInfo) => onDetailsInfo?.(topKey, info), [onDetailsInfo, topKey]);

  const route = top.route;
  let screen: React.ReactNode;
  switch (route.name) {
    case "home":
      screen = <HomeCatalog mem={mem} onOpen={open} onContinue={(item) => onContinue?.(top, item)} onLive={onLive && ((c, l) => (rememberFocus(mem), onLive(c, l)))} />;
      break;
    case "tv":
      screen = (
        <TvChannelsScreen
          mem={mem}
          onPlay={(c, l) => (rememberFocus(mem), onLive?.(c, l))}
          onDay={(c) => (rememberFocus(mem), setStack((s) => push(s, { name: "tv-day", channel: c })))}
        />
      );
      break;
    case "tv-day":
      screen = <TvDayScreen key={route.channel.id} channel={route.channel} mem={mem} onPlay={(c) => (rememberFocus(mem), onLive?.(c, [c]))} />;
      break;
    case "video":
    case "video-search":
    case "video-channel": {
      const playVideo = (v: VideoItem, start: number | null) => (rememberFocus(mem), onVideo?.(v, start));
      const toChannel = (id: string, title: string) => (rememberFocus(mem), setStack((s) => push(s, { name: "video-channel", id, title })));
      screen =
        route.name === "video" ? (
          <VideoScreen mem={mem} onPlay={playVideo} onChannel={toChannel} onSearch={() => (rememberFocus(mem), setStack((s) => push(s, { name: "video-search" })))} />
        ) : route.name === "video-search" ? (
          <VideoSearchScreen mem={mem} onPlay={playVideo} onChannel={toChannel} />
        ) : (
          <VideoChannelScreen key={route.id} id={route.id} name={route.title} mem={mem} onPlay={playVideo} />
        );
      break;
    }
    case "search":
      screen = <SearchScreen mem={mem} onOpen={open} />;
      break;
    case "mine":
      screen = <MineScreen mem={mem} onOpen={open} onHome={() => onMenu("home")} />;
      break;
    case "messages":
      screen = <MessagesScreen mem={mem} onHome={() => onMenu("home")} />;
      break;
    case "browse":
      screen = <BrowseScreen kind={route.kind} mem={mem} onOpen={open} />;
      break;
    case "explore":
      screen = (
        <ExploreScreen
          mem={mem}
          onTile={(tile) => {
            rememberFocus(mem);
            setStack((s) =>
              push(
                s,
                tile.collection_id
                  ? { name: "collection", id: tile.collection_id, title: tile.title }
                  : tile.curated_id
                    ? { name: "curated", id: tile.curated_id, title: tile.title }
                    : { name: "tile", tile: tile.id, title: tile.title },
              ),
            );
          }}
        />
      );
      break;
    case "tile":
      screen = <TileScreen tile={route.tile} title={route.title} mem={mem} onOpen={open} />;
      break;
    case "person":
      screen = <PersonScreen key={route.tmdbId} tmdbId={route.tmdbId} name={route.title} mem={mem} onOpen={open} />;
      break;
    case "collection":
      screen = <CollectionScreen id={route.id} title={route.title} mem={mem} onOpen={open} />;
      break;
    case "curated":
      screen = <CuratedScreen key={route.id} id={route.id} title={route.title} mem={mem} onOpen={open} />;
      break;
    case "history":
      screen = <HistoryScreen mem={mem} onOpen={open} />;
      break;
    case "new-episodes": {
      // OK plays the episode like a «Продолжить» card with that next episode.
      const toItem = (it: NewEpisodeItem): ContinueItem => ({
        media: it.media,
        progress: null,
        next_up: { episode_id: it.episode.id, season_number: it.episode.season_number, episode_number: it.episode.episode_number, name: it.episode.name, air_date: it.episode.air_date },
      });
      screen = (
        <NewEpisodesScreen
          mem={mem}
          onPlay={(it) => (rememberFocus(mem), onContinue?.(top, toItem(it)))}
          onOpen={(it) => open(it.media, t("newep.title"), { season: it.episode.season_number, episode: it.episode.episode_number })}
          onHome={() => onMenu("home")}
        />
      );
      break;
    }
    case "surprise":
      screen = (
        <SurpriseScreen
          mem={mem}
          onOpen={open}
          onWatch={(m) => {
            // Movies play right away (best release, like Details' Play); series open Details for the episode choice.
            if (m.kind !== "movie" || !onPlay) return open(m, t("nav.surprise"));
            rememberFocus(mem);
            // startLocalPlay only reads id/kind/title/poster/backdrop, which a summary carries.
            onPlay(top, m as unknown as MediaDetail, null, "best");
          }}
        />
      );
      break;
    case "ask":
      screen = <AskScreen mem={mem} profileId={profile.id} onOpen={open} />;
      break;
    case "details":
      screen = (
        <DetailsScreen
          id={route.id}
          preview={route.preview}
          season={route.season}
          episode={route.episode}
          from={route.from}
          profile={profile}
          mem={mem}
          onOpen={open}
          onPerson={(tmdbId, name) => {
            rememberFocus(mem);
            setStack((s) => push(s, { name: "person", tmdbId, title: name }));
          }}
          onBack={onBack}
          onInfo={reportInfo}
          onPlay={(media, episode, how, startAt) => {
            rememberFocus(mem);
            onPlay?.(top, media, episode, how, startAt);
          }}
        />
      );
      break;
  }

  // ---- fast way up: Back (via App) / Channel▲ jump to the top, Channel▼ to the next section.
  const jumpRef = useRef<(toMenu: boolean) => boolean>(() => false);
  const backRef = useRef<(toMenu: boolean) => boolean>(() => false);
  const jump = (toMenu: boolean) => {
    const k = getCurrentFocusKey() ?? "";
    if (!k || k.startsWith("menu")) return false;
    if (route.name === "details") {
      // Full-screen Details (no menu): scrolled → back to Play and the hero.
      if ((mem.get<number>("ty") ?? 0) <= 0 || k === "d-play") return false;
      setFocus("d-play");
      return true;
    }
    if (toMenu) {
      // Focus the menu first, then let the screen scroll back: scrolling
      // unmounts far rows (only nearby ones render), and if the focused card
      // were still focused then, the focus engine would pull focus back into
      // the content ~300 ms later (keys pressed meanwhile seemed to skip tabs).
      setFocus("menu");
      afterMenuFocus(() => runToTop(true));
      return true;
    }
    // The screen resets its scroll; Home may move to its first row instead.
    if (runToTop(false)) return true;
    setFocus("menu");
    return true;
  };
  // Detours (an actor's page from Details, a channel's day from «ТВ»): Back returns at once.
  const backToMenu = (toMenu: boolean) => route.name !== "person" && route.name !== "tv-day" && jump(toMenu);
  useEffect(() => {
    jumpRef.current = jump;
    backRef.current = backToMenu;
  });
  useEffect(() => {
    // Back goes straight to the menu (one press from any row), like Channel▲.
    setBackFirst(() => !settings && !guide && backRef.current(true));
    return () => setBackFirst(null);
  }, [settings, guide]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = playerKey(e);
      if (k !== "chup" && k !== "chdown") return;
      e.preventDefault();
      if (k === "chup") jumpRef.current(true);
      else navigateByDirection("down", {});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Code splitting (lazy.tsx): the other screens' chunks load in the background
  // once the catalog is up; a focused menu tab (or a card: Details next) fetches
  // its chunk right away. Read after the key moved focus.
  useEffect(() => {
    prefetchLater();
    let id = 0;
    const onKey = () => {
      clearTimeout(id);
      id = window.setTimeout(() => {
        const k = getCurrentFocusKey() ?? "";
        if (k.startsWith("menu-")) prefetchMenu(k.slice(5));
        else if (k && !k.startsWith("menu")) prefetchDetails();
      }, 120);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(id);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  // «▲ К вкладкам — Назад»: once per session, the first time a screen scrolls (Терминал / Проектор).
  const deep = useDeep();
  const [hintDone, setHintDone] = useState(hintShown);
  const hintOn = !hintDone && deep && design !== "kinozal" && route.name !== "details";
  useEffect(() => {
    if (!hintOn) return;
    hintShown = true;
    const id = setTimeout(() => setHintDone(true), 5000);
    return () => clearTimeout(id);
  }, [hintOn]);

  const nav: NavProps = {
    active: menuFor(route),
    profile,
    unread,
    mine: watchlist.data?.total_results ?? null,
    newEpisodes,
    attribution: cfg.data?.attribution ?? t("catalog.attribution"),
    onSelect: onMenu,
  };
  const box = frame.box;
  const chrome = route.name !== "details";
  return (
    <div data-design-shell={design} data-design-skin={skin} className={`relative h-full w-full overflow-hidden ${design === "terminal" ? "t-grid" : "bg-bg"}`}>
      <SkinBackground />
      <FocusRecorderProvider value={record}>
        <FocusSection key={top.key} focusKey={`content-${top.key}`} forceFocus className="absolute" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
          {/* Screens draw on the full 1920×1080 canvas (backdrops may run under the chrome). */}
          <div className="absolute overflow-hidden" style={{ left: -box.left, top: -box.top, width: 1920, height: 1080 }}>
            {/* Lazily loaded screens (lazy.tsx): a late spinner until the chunk arrives; the screen focuses itself once ready. */}
            <Suspense fallback={<ScreenWait />}>{screen}</Suspense>
          </div>
        </FocusSection>
      </FocusRecorderProvider>
      {/* «Уютный режим»: palette while the catalog is up, the ambience on Home only (under the holiday layer). */}
      <TvCozyLayer onHome={route.name === "home" && !settings && !guide} />
      {/* Idle Home: the déjà-vu cat, the screensaver; the secret remote code (idle/). */}
      <TvIdleLayer onHome={route.name === "home" && !settings && !guide && !quiz} />
      {/* Holiday animations: over the content, under the menu and overlays; menu screens only. */}
      {chrome && !settings && !guide && <TvSeasonLayer />}
      {/* «Конструктивизм»: «очередь за дефицитом» over a popular title opened in the catalog (not from the phone). */}
      {route.name === "details" && skin === "constructivism" && route.preview && <CvQueue key={top.key} entryKey={String(top.key)} media={route.preview} />}
      {/* Details is full-screen in every design (the PDF's p5/p8/p11): Back returns. */}
      {chrome && design === "kinozal" && <KinozalRail {...nav} />}
      {chrome && design === "terminal" && (
        <>
          <TerminalBar {...nav} />
          <TerminalTicker profile={profile} unread={unread} />
        </>
      )}
      {chrome && design === "projector" && <ProjectorBar {...nav} />}
      {hintOn && chrome && (
        <div data-testid="top-hint" className={`tv-key-hint absolute left-1/2 z-20 -translate-x-1/2 px-6 py-2 text-[20px] text-text/80 ${design === "terminal" ? "t-label bottom-[56px]" : "bottom-[28px] rounded-full"}`}>
          {t("tvd.hint.to_tabs")}
        </div>
      )}
      {settings && (
        <Suspense fallback={null}>
          <SettingsScreen
            profile={profile}
            onClose={() => {
              setSettings(false);
              setTimeout(() => void setFocus("menu-settings"), 0);
            }}
          />
        </Suspense>
      )}
      <QuizInvite profileId={profile.id} enabled={route.name === "home" && !settings && !guide && !quiz} onStart={() => setQuiz(true)} />
      {quiz && (
        <Suspense fallback={null}>
          <TasteQuiz
            profileId={profile.id}
            onClose={() => {
              setQuiz(false);
              setTimeout(() => void setFocus(`content-${top.key}`), 0);
            }}
          />
        </Suspense>
      )}
      {guide && (
        <Suspense fallback={null}>
          <Onboarding
            profile={profile}
            onDone={() => {
              setGuideDone(profile.id);
              setTimeout(() => void setFocus(`content-${top.key}`), 0);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

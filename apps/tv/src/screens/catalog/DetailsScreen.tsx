import { useEffect, useMemo, useRef, useState } from "react";
import { MyNote } from "../../foryou/MyNote";
import { ApiError, type CatalogConfig, type Episode, type MediaDetail, type MediaSummary, type Profile, type Release, type WatchProgress } from "@martytv/contracts";
import { catalogLang, episodeCode, formatDate, formatRuntime, imageUrl, placeholderColor, saveDataOn, variantRelease, type WarmTarget } from "@martytv/media-types";
import { GenreReaction, showAfterButton, showQuotesButton, showRecapButton, useI18n } from "@martytv/ui";
import { FocusBlock, FocusButton, FocusLine, getCurrentFocusKey, offsetWithin, setFocus, useInitialFocus } from "../../focus";
import { playerKey } from "../../player/keys";
import { cardKey } from "../../catalog/focusKeys";
import { pickSeason } from "../../catalog/seasons";
import type { DetailsInfo } from "../../remote/state";
import type { RouteMemory } from "../../catalog/nav";
import { isUnavailable, useCatalogConfig, useMedia, useRelated, useSeason } from "../../catalog/queries";
import { HRow } from "../../components/HRow";
import { Img, legacyColor } from "../../components/Img";
import { ErrorState, RowSkeleton } from "../../components/States";
import { WatchBadges } from "../../components/Poster";
import { ActionMenu, type MenuAction } from "../../components/ActionMenu";
import { formatClock } from "../../player/format";
import { useReleasesLazy } from "../../player/data";
import { useInstantPlay } from "../../player/instantPlay";
import { engineProbe, nextRelease } from "../../player/codecs";
import { useSettings } from "../../profile/settings";
import { useFilmTheme } from "../../filmtheme/load";
import type { PlayHow } from "./CatalogShell";
import { FRAMES, useDesign, type Design } from "../../design/context";
import { useRecoInbox, useRecoSeen, useServerFeatures, useSettled, useToggleWatchlist } from "../../design/data";
import { RecoNote } from "../../design/reco";
import { FamilyNote } from "../../family/Family";
import { Brackets, PosterCard, WideCard } from "../../design/cards";
import { HEADER_H, KinozalBackdrop, KinozalHeader, ProjectorBackdrop, ProjectorHeader, TerminalBackdrop, TerminalHeader, type DetailActions, type SourceState } from "../../design/details";
import { TrailerLayer } from "../../design/TrailerLayer";
import { AwardsPanel } from "../../design/awards";
import { FactsPanel, QuotesPanel } from "../../design/trivia";
import { SoundtrackPanel } from "../../design/soundtrack";
import { useFacts, useQuotes } from "../../catalog/trivia";
import { useCompanion } from "../../catalog/companion";
import { AfterCreditsPanel, RecapPanel } from "../../design/companion";
import { indexTag } from "../../design/format";
import { useMediaProgress, useSetWatched } from "../../watch/api";
import { adoptPlayed, lastPlayed } from "../../watch/lastPlayed";
import { watchOnlineItems } from "../../player/online";
import { useOnlineLazy } from "../../player/onlineQuery";
import { OnlinePicker, type OnlineChoice } from "../../player/OnlinePicker";
import { player } from "../../player/controller";
import { findDownload, useDownloadLabel, useMediaDownloads } from "../../player/downloads";
import { episodeProgress, focusEpisodeIndex, resumeChoice, seasonCount, suggestedEpisode } from "../../watch/resume";

const SEASON_DELAY = 350;
/** Where an entered section's top lands on screen (px from the top). */
const SECTION_TOP = 90;
/** Details searches releases (for the auto-selected source) once it has been open this long. */
const RELEASES_DELAY = 500;

/** Card sizes in Details' rows per design. */
const CARDS: Record<Design, { poster: [number, number]; gap: number; wide: boolean }> = {
  kinozal: { poster: [204, 306], gap: 28, wide: false },
  terminal: { poster: [156, 234], gap: 20, wide: false },
  projector: { poster: [340, 191], gap: 30, wide: true },
};

type CastMember = MediaDetail["cast"][number];

export function DetailsScreen({
  id,
  preview,
  season: requestedSeason,
  episode: requestedEpisode,
  from,
  profile,
  mem,
  onOpen,
  onPerson,
  onBack,
  onInfo,
  onPlay,
}: {
  id: string;
  /** Row/section Details was opened from. */
  from?: string;
  profile: Profile;
  preview?: MediaSummary;
  /** Season to preselect / episode to focus first (sent from a phone). */
  season?: number;
  episode?: number;
  mem: RouteMemory;
  onOpen: (item: MediaSummary, from?: string) => void;
  /** OK on a cast card: that person's films and series. */
  onPerson?: (tmdbId: number, name: string) => void;
  onBack: () => void;
  /** Reports title/poster/selected season for the TV's device state. */
  onInfo?: (info: DetailsInfo) => void;
  /**
   * Play: opens the release picker (`best` skips it and plays the best
   * match — the remote's Play key). Series pass the episode.
   */
  onPlay?: (media: MediaDetail, episode: Episode | null, how: PlayHow, startAt?: number) => void;
}) {
  const { t, locale } = useI18n();
  const features = useServerFeatures();
  const design = useDesign();
  const frame = FRAMES[design];
  const [trailer, setTrailer] = useState(false);
  const toggleList = useToggleWatchlist();
  const [listed, setListed] = useState<boolean | null>(null);
  const cfg = useCatalogConfig();
  const q = useMedia(id);
  const d = q.data;
  // «Тема под фильм»: on once the theme's chunk is here (never delays the page).
  const filmTheme = useFilmTheme(d);
  const settings = useSettings();
  const progressQ = useMediaProgress(id);
  const mp = progressQ.data ?? null;
  const setWatched = useSetWatched(id);
  const suggested = d?.kind === "series" ? suggestedEpisode(mp) : null;
  /** Resume choice / episode options shown over the screen. */
  const [menu, setMenu] = useState<{ title: string; subtitle?: string | null; actions: MenuAction[]; testId: string } | null>(null);
  const similar = useRelated(id, "similar", !!d);
  const recs = useRelated(id, "recommendations", !!d);
  // Back from the player that moved on (next episode, maybe into another season): that episode's season and card.
  const [played] = useState(() => adoptPlayed(mem, lastPlayed(id), Date.now()));
  const [season, setSeason] = useState<number | null>(() => mem.get<number>("season") ?? requestedSeason ?? null);
  // Without a choice, the season of the suggested ("next up") episode.
  const seasonNo = d ? (d.kind === "series" ? pickSeason(d.seasons, season ?? suggested?.season ?? null) : null) : season;
  const seasonQ = useSeason(id, d?.kind === "series" ? seasonNo : null);
  const [ty, setTy] = useState(() => mem.get<number>("ty") ?? 0);
  const seasonTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(seasonTimer.current), []);

  // Back from the picker/player (started from ☰ or a sources row) lands on Play.
  useState(() => {
    const fk = mem.focusKey;
    if (fk === "d-sources" || fk === "d-online" || fk?.startsWith("d-src-")) mem.set("focusKey", "d-play");
    return null;
  });
  useInitialFocus(!!d, mem, () => "d-play");

  const info = d ?? preview;
  const infoTitle = info?.title ?? null;
  const infoPoster = info?.poster_path ?? null;
  const infoKind = info?.kind ?? null;
  const infoSeason = infoKind === "series" ? seasonNo : null;
  useEffect(() => {
    if (infoTitle === null && infoKind === null) return;
    onInfo?.({ title: infoTitle, poster_path: infoPoster, kind: infoKind, season_number: infoSeason });
  }, [onInfo, infoTitle, infoPoster, infoKind, infoSeason]);
  useInitialFocus(isUnavailable(q.error, cfg.data), mem, () => "menu-home");

  const chooseSeason = (n: number) => {
    clearTimeout(seasonTimer.current);
    setSeason(n);
    mem.set("season", n);
  };
  /**
   * Scrolls the page (a transform on the track) so the entered section sits
   * near the top; the header (first) scrolls back to 0, restoring the hero.
   * The offset is measured against the track itself: sections may sit in
   * wrappers, so the block's offset in its parent isn't enough.
   */
  const scrollTo = (first: boolean) => (y: number, node: HTMLElement) => {
    const track = node.closest ? node.closest(".d-track") : null;
    const top = track ? (offsetWithin(node, track) ?? y) : y;
    const v = first ? 0 : Math.max(0, top - SECTION_TOP);
    setTy(v);
    mem.set("ty", v);
  };
  /**
   * The episode the header's Play starts: the one last focused in this
   * season, else the suggested (next up) one, else the first.
   */
  const headerEpisode = (): Episode | null => {
    const eps = seasonQ.data?.episodes ?? [];
    if (eps.length === 0) return null;
    const i = focusEpisodeIndex(eps, {
      remembered: mem.get<number>(`idx-ep-${seasonNo}`),
      played: played?.season === seasonNo ? played : null,
      requested: seasonNo === requestedSeason ? requestedEpisode : undefined,
      suggestedId: suggested?.id,
    });
    return eps[i] ?? eps[0]!;
  };
  const progressOf = (episode: Episode | null): WatchProgress | null => (episode ? episodeProgress(mp, episode.id) : (mp?.movie ?? null));
  /** Play: in-progress items ask "Resume at … / Start over" first. */
  const play = (episode: Episode | null, how: PlayHow, auto = false) => {
    if (!d || !onPlay) return;
    if (d.kind === "series" && !episode) return;
    const prog = progressOf(episode);
    const choice = resumeChoice(prog);
    if (choice.kind !== "resume") return onPlay(d, episode, how, 0);
    const code = episode ? episodeCode(episode.season_number, episode.episode_number) : null;
    const go = (at: number) => {
      setMenu(null);
      // «Продолжить» with the automatic choice: the source it was last watched with.
      onPlay(d, episode, auto && at > 0 && prog?.source_id ? { source_id: prog.source_id } : how, at);
    };
    setMenu({
      title: t("tv.watch.resume_question"),
      subtitle: [d.title, code].filter(Boolean).join(" · "),
      testId: "resume-menu",
      actions: [
        { key: "resume", label: `▶  ${t("watch.resume_at", { time: formatClock(choice.at) })}`, primary: true, onPress: () => go(choice.at) },
        { key: "restart", label: `↺  ${t("watch.start_over")}`, onPress: () => go(0) },
      ],
    });
  };
  /** Long-press OK on an episode: watched marks for it / its season. */
  const episodeOptions = (e: Episode) => {
    const p = episodeProgress(mp, e.id);
    const sc = seasonCount(mp, e.season_number);
    const seasonDone = !!sc && sc.completed >= sc.total;
    const run = (v: { watched: boolean; episode_id?: string; season_number?: number }) => {
      setMenu(null);
      setWatched.mutate(v);
    };
    const restart = () => {
      setMenu(null);
      if (d) onPlay?.(d, e, "pick", 0);
    };
    setMenu({
      title: e.name || episodeCode(e.season_number, e.episode_number),
      subtitle: episodeCode(e.season_number, e.episode_number),
      testId: "episode-menu",
      actions: [
        p?.completed
          ? { key: "unwatched", label: t("watch.mark_unwatched"), onPress: () => run({ watched: false, episode_id: e.id }) }
          : { key: "watched", label: t("watch.mark_watched"), primary: true, onPress: () => run({ watched: true, episode_id: e.id }) },
        seasonDone
          ? { key: "season-unwatched", label: t("tv.watch.mark_season_unwatched"), onPress: () => run({ watched: false, season_number: e.season_number }) }
          : { key: "season-watched", label: t("watch.mark_season_watched"), onPress: () => run({ watched: true, season_number: e.season_number }) },
        ...(p && !p.completed ? [{ key: "restart", label: t("tv.watch.play_from_start"), onPress: restart }] : []),
      ],
    });
  };
  const playRef = useRef({ play, headerEpisode, episodes: seasonQ.data?.episodes ?? [] });
  useEffect(() => {
    playRef.current = { play, headerEpisode, episodes: seasonQ.data?.episodes ?? [] };
  });

  // Quick path: the remote's Play key plays the best release right away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = playerKey(e);
      if (k !== "play" && k !== "playpause") return;
      e.preventDefault();
      const r = playRef.current;
      const focus = getCurrentFocusKey() ?? "";
      const ep = focus.startsWith("ep-") ? r.episodes.find((x) => `ep-${x.id}` === focus) : undefined;
      r.play(ep ?? r.headerEpisode(), "best", true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** "Play" / "Resume" / "Watch again" (series: with the episode code). */
  const playLabel = (episode: Episode | null): string => {
    if (d?.kind === "series") {
      if (!episode) return t("catalog.tv.play");
      const code = episodeCode(episode.season_number, episode.episode_number);
      const c = resumeChoice(episodeProgress(mp, episode.id));
      // «Продолжить S02E05 · 23:14»: the resume target and position.
      return c.kind === "resume" ? `${t("tv.watch.resume_episode", { code })} · ${formatClock(c.at)}` : t("tv.watch.play_episode", { code });
    }
    const c = resumeChoice(mp?.movie);
    return c.kind === "resume" ? `${t("tv.watch.resume")} · ${formatClock(c.at)}` : c.kind === "again" ? t("watch.watch_again") : t("catalog.tv.play");
  };

  // ---- the auto-selected source (the "idea from B"): searched lazily once Details settles.
  const ep = d?.kind === "series" ? headerEpisode() : null;
  const relQ = d && (d.kind !== "series" || ep) ? { media_id: d.id, season: ep?.season_number ?? null, episode: ep?.episode_number ?? null, profile_id: profile.id, lang: catalogLang(locale) } : null;
  const relKey = relQ ? JSON.stringify(relQ) : null;
  const settledKey = useSettled(relKey, RELEASES_DELAY);
  const releases = useReleasesLazy(settledKey && relQ ? relQ : null);
  const probe = useMemo(() => engineProbe(), []);
  const relItems = useMemo(() => releases.data?.items ?? [], [releases.data]);
  // «Смотреть» uses the TV's own ranking too (measured rate / device cap, compat), like playBest.
  const runtime = d && d.kind !== "series" && d.runtime ? d.runtime * 60 : null;
  const bestRelease = useMemo(() => nextRelease(relItems, [], [], probe, { ...player.rankEnv(null), probe, runtime }), [relItems, probe, runtime]);
  const sources: SourceState = {
    status: !settledKey || releases.isPending ? (relQ ? "loading" : "idle") : releases.isError ? "error" : relItems.length === 0 ? "none" : "ok",
    best: bestRelease,
    items: relItems,
  };
  // «Мгновенный старт»: the server warms what the Play button starts — the source this was last watched with
  // when it resumes («Продолжить», as `play` does), else the best release — once the page stays on it.
  const warmProg = progressOf(ep);
  const warmResume = resumeChoice(warmProg);
  const warmAt = warmResume.kind === "resume" ? warmResume.at : 0;
  const warmTarget: WarmTarget | null =
    !d || !onPlay || (d.kind === "series" && !ep)
      ? null
      : warmAt > 0 && warmProg?.source_id
        ? { media_id: d.id, profile_id: profile.id, source_id: warmProg.source_id, start_seconds: warmAt, ...(ep && { episode_id: ep.id }) }
        : bestRelease && !releases.isPending
          ? { media_id: d.id, profile_id: profile.id, release_id: bestRelease.id, start_seconds: warmAt, ...(ep && { episode_id: ep.id }) }
          : null;
  useInstantPlay(warmTarget, () => !player.busy() && !saveDataOn());
  // «Смотреть онлайн»: online (non-anime) variants, fetched once Details settles; series: the shown season.
  const onlineQ = d ? { media_id: d.id, season: d.kind === "series" ? (seasonNo ?? 1) : null, episode: null, profile_id: profile.id, lang: catalogLang(locale) } : null;
  const onlineSettled = useSettled(onlineQ ? JSON.stringify(onlineQ) : null, RELEASES_DELAY);
  const onlineRes = useOnlineLazy(onlineQ, !!onlineSettled);
  const onlineItems = useMemo(() => watchOnlineItems(onlineRes.data), [onlineRes.data]);
  // «На сервере ✓» on episodes the server has downloaded (or is downloading).
  const downloads = useMediaDownloads(d?.kind === "series" ? d.id : null);
  const dlLabel = useDownloadLabel();
  const [onlineOpen, setOnlineOpen] = useState(false);
  const [awardsOpen, setAwardsOpen] = useState(false);
  // «Цитаты»: prefetched (none found → no button); «Факты»: loaded on open.
  const [triviaOpen, setTriviaOpen] = useState<"quotes" | "facts" | null>(null);
  const [soundtrackOpen, setSoundtrackOpen] = useState(false);
  const quotesQ = useQuotes(id, !!d);
  const factsQ = useFacts(id, triviaOpen === "facts");
  const hasQuotes = showQuotesButton(quotesQ);
  // The button vanishing under focus (the prefetch found nothing): focus moves to «Факты».
  useEffect(() => {
    if (!hasQuotes && getCurrentFocusKey() === "d-quotes") setFocus("d-facts");
  }, [hasQuotes]);
  // «Ранее в сериале» / «После титров»: chips only when the profile qualifies (refetched as progress changes).
  const companionQ = useCompanion(id, profile.id, !!d, progressQ.dataUpdatedAt);
  const [companionOpen, setCompanionOpen] = useState<"recap" | "after" | null>(null);
  const hasRecap = showRecapButton(companionQ.data);
  const hasAfter = showAfterButton(companionQ.data);
  useEffect(() => {
    const fk = getCurrentFocusKey();
    if ((!hasRecap && fk === "d-recap") || (!hasAfter && fk === "d-after")) setFocus("d-facts");
  }, [hasRecap, hasAfter]);


  // Recommended by someone: their note, and opening Details marks it seen.
  const inbox = useRecoInbox();
  const recoSeen = useRecoSeen();
  const reco = inbox.data?.items.find((r) => r.media.id === id) ?? null;
  const recoId = reco && !reco.seen_at ? reco.id : null;
  const markSeen = recoSeen.mutate;
  useEffect(() => {
    if (recoId) markSeen(recoId);
  }, [recoId, markSeen]);

  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div data-media-id={id} className="flex h-full items-center px-20">
        {notFound ? (
          <div>
            <p className="text-5xl font-bold">{t("catalog.detail.not_found")}</p>
            <div className="mt-10 flex">
              <FocusButton focusKey="d-back" autoFocus onPress={onBack} className="rounded-2xl bg-surface-2 px-10 py-5 text-3xl">
                {t("common.back")}
              </FocusButton>
            </div>
          </div>
        ) : (
          <ErrorState focusKey="d-retry" error={q.error} unavailable={isUnavailable(q.error, cfg.data)} onRetry={() => void q.refetch()} />
        )}
      </div>
    );
  }

  const base: MediaSummary | undefined = d ?? preview;
  const isSeries = base?.kind === "series";
  const seasons = d?.seasons ?? [];
  const episodes = seasonQ.data?.episodes ?? [];
  const cast = d?.cast ?? [];
  const sim = similar.data?.items ?? [];
  const rec = recs.data?.items ?? [];
  const cards = CARDS[design];
  const [pw, ph] = cards.poster;

  const keys = ["d-actions"];
  if (isSeries && seasons.length > 0) keys.push("d-seasons", "d-episodes");
  // Down walks every section in order (actions → seasons → episodes → cast → similar → recommendations).
  if (cast.length > 0) keys.push("d-cast");
  if (sim.length > 0) keys.push("d-similar");
  if (rec.length > 0) keys.push("d-recs");

  const rowTitle = (title: string, n: number) =>
    design === "terminal" ? (
      <h2 className="t-label mb-1 text-[25px]">
        {indexTag(n)} / {title}
      </h2>
    ) : (
      <h2 className="mb-1 text-[31px] font-bold">{title}</h2>
    );

  const mediaRow = (key: string, items: MediaSummary[], from: string) => (
    <HRow
      focusKey={`${key}-row`}
      items={items}
      itemKey={(it) => cardKey(key, it.id)}
      itemWidth={pw}
      itemHeight={ph + (cards.wide ? 0 : 76)}
      gap={cards.gap}
      pad={design === "projector" ? 40 : 24}
      viewport={1920 - frame.x}
      initialIndex={mem.get<number>(`idx-${key}`) ?? 0}
      onIndexChange={(i) => mem.set(`idx-${key}`, i)}
      onSelect={(it) => onOpen(it, from)}
      quick={(it) => ({ item: it, onOpen: () => onOpen(it, from) })}
      renderItem={(it, focused, i) =>
        cards.wide ? (
          <WideCard media={it} title={it.title} cfg={cfg.data} width={pw} height={ph} focused={focused} />
        ) : (
          <PosterCard item={it} cfg={cfg.data} width={pw} height={ph} focused={focused} index={i + 1} showTitle />
        )
      }
    />
  );
  const castRow = (key: string) => (
    <HRow
      focusKey={`${key}-row`}
      items={cast}
      itemKey={(c) => cardKey("cast", `${c.person_tmdb_id}-${c.order}`)}
      itemWidth={190}
      itemHeight={370}
      gap={cards.gap}
      viewport={1920 - frame.x}
      initialIndex={mem.get<number>("idx-cast") ?? 0}
      onIndexChange={(i) => mem.set("idx-cast", i)}
      onSelect={(c) => onPerson?.(c.person_tmdb_id, c.name)}
      renderItem={(c, focused) => <CastCard c={c} cfg={cfg.data} focused={focused} design={design} />}
    />
  );

  const inList = listed ?? (d?.me ? d.me.in_watchlist : null);
  const moreMenu = () => {
    if (!d) return;
    const actions: MenuAction[] = [{ key: "pick", label: `☰  ${t("tvd.more.pick")}`, primary: true, onPress: () => (setMenu(null), play(headerEpisode(), "pick")) }];
    if (inList !== null) actions.push({ key: "list", label: inList ? t("tvd.more.list_remove") : t("tvd.more.list_add"), onPress: () => (setMenu(null), toggleWatch()) });
    if (!isSeries && mp)
      actions.push({
        key: "watched",
        label: mp.movie?.completed ? `○  ${t("watch.mark_unwatched")}` : `✓  ${t("watch.mark_watched")}`,
        onPress: () => (setMenu(null), setWatched.mutate({ watched: !mp.movie?.completed })),
      });
    if (features.music) actions.push({ key: "soundtrack", label: `♫  ${t("soundtrack.tv_menu")}`, onPress: () => (setMenu(null), setSoundtrackOpen(true)) });
    setMenu({ title: d.title, subtitle: t("tvd.more.title"), testId: "more-menu", actions });
  };
  const toggleWatch = () => {
    if (!d || inList === null) return;
    setListed(!inList);
    toggleList.mutate({ mediaId: d.id, on: !inList });
  };
  const actions: DetailActions = {
    playLabel: playLabel(isSeries ? ep : null),
    // One press: the auto-selected source; still searching → the best match is searched by the player.
    onPlay: () => play(ep, bestRelease ?? (sources.status === "loading" ? "best" : "pick"), true),
    onSources: () => play(ep, "pick"),
    onTrailer: d?.trailer ? () => setTrailer(true) : null,
    inList,
    onList: toggleWatch,
    onMore: moreMenu,
    onRelease: (r: Release) => play(ep, r),
    onRefine: () => play(ep, "pick"),
    onOnline: d && onlineItems.length > 0 ? () => setOnlineOpen(true) : null,
    onAwards: d?.awards?.length ? () => setAwardsOpen(true) : null,
    onQuotes: d && hasQuotes ? () => setTriviaOpen("quotes") : null,
    onFacts: d ? () => setTriviaOpen("facts") : null,
    extras: [
      ...(d && hasRecap ? [{ focusKey: "d-recap", testId: "tv-recap-button", label: `↺ ${t("companion.recap")}`, onPress: () => setCompanionOpen("recap") }] : []),
      ...(d && hasAfter ? [{ focusKey: "d-after", testId: "tv-after-button", label: `◐ ${t("companion.after")}`, onPress: () => setCompanionOpen("after") }] : []),
    ],
  };
  const playOnline = (c: OnlineChoice) => {
    setOnlineOpen(false);
    const episode = isSeries ? (seasonQ.data?.episodes.find((e) => e.episode_number === c.episode) ?? null) : null;
    player.preferQuality(c.variant.id, c.quality);
    play(episode, variantRelease(c.variant));
  };

  const myNote = base?.me?.note;
  const own = reco ? <RecoNote r={reco} design={design} /> : myNote ? <MyNote note={myNote} design={design} /> : null;
  // «Оценки семьи» below the note (renders nothing when nobody shares this title).
  const note = (
    <>
      {own}
      <FamilyNote mediaId={base?.id} design={design} spaced={!!own} />
    </>
  );
  const header = base ? (
    design === "terminal" ? (
      <TerminalHeader item={base} detail={d} cfg={cfg.data} from={from} profileName={profile.name} progress={isSeries ? null : (mp?.movie ?? null)} sources={sources} actions={actions} aside={note} />
    ) : design === "projector" ? (
      <ProjectorHeader item={base} detail={d} cfg={cfg.data} from={from} profileName={profile.name} progress={isSeries ? null : (mp?.movie ?? null)} sources={sources} actions={actions} aside={note} />
    ) : (
      <KinozalHeader item={base} detail={d} cfg={cfg.data} from={from} profileName={profile.name} progress={isSeries ? null : (mp?.movie ?? null)} sources={sources} actions={actions} aside={note} />
    )
  ) : (
    <HeaderSkeleton design={design} />
  );
  const Back = design === "terminal" ? TerminalBackdrop : design === "projector" ? ProjectorBackdrop : KinozalBackdrop;
  const square = design === "terminal";
  const chip = (selected: boolean, focused: boolean) =>
    `tv-focus tv-chip flex h-[68px] items-center justify-center truncate px-6 text-[24px] font-bold ${square ? "t-label" : "rounded-control"} ${
      focused ? "is-focused" : selected ? "bg-accent text-on-accent" : "bg-surface-2 text-text"
    }`;
  let n = 2;

  return (
    <div data-media-id={id} data-design={design} data-film-theme={filmTheme ?? undefined} className="relative h-full w-full overflow-hidden">
      <Back item={base} cfg={cfg.data} dim={ty > 0} />

      <FocusLine focusKey="d-sections" keys={keys} className="d-track tv-track absolute left-0 right-0 top-0" style={{ transform: `translate3d(0,${-ty}px,0)` }}>
        <FocusBlock focusKey="d-actions" onEnter={scrollTo(true)}>
          <div className="relative">
            {header}
            {/* Cineko reacts to the genre: top right, clear of every skeleton's title, table and notes. */}
            {d && <GenreReaction genres={d.genres} size={96} className="pointer-events-none !absolute right-[110px] top-[110px]" />}
          </div>
        </FocusBlock>

        <div style={{ paddingLeft: frame.x }}>
          {keys.includes("d-seasons") && (
            <FocusBlock focusKey="d-seasons" onEnter={scrollTo(false)} className="pb-4">
              {rowTitle(t("catalog.detail.seasons"), n++)}
              <HRow
                focusKey="d-seasons-row"
                items={seasons}
                itemKey={(s) => cardKey("season", s.season_number)}
                itemWidth={240}
                itemHeight={68}
                gap={18}
                viewport={1920 - frame.x}
                initialIndex={Math.max(0, seasons.findIndex((s) => s.season_number === seasonNo))}
                onIndexChange={(_, s) => {
                  clearTimeout(seasonTimer.current);
                  seasonTimer.current = setTimeout(() => chooseSeason(s.season_number), SEASON_DELAY);
                }}
                onSelect={(s) => chooseSeason(s.season_number)}
                renderItem={(s, focused) => {
                  const c = seasonCount(mp, s.season_number);
                  const done = !!c && c.completed >= c.total;
                  return (
                    <div data-season={s.season_number} className={chip(s.season_number === seasonNo, focused)}>
                      {s.season_number === 0 ? t("catalog.detail.specials") : t("catalog.detail.season", { n: s.season_number })}
                      {c && c.completed > 0 && (
                        <span data-season-progress className="ml-3 text-xl font-normal opacity-80">
                          {done ? "✓" : `${c.completed}/${c.total}`}
                        </span>
                      )}
                    </div>
                  );
                }}
              />
            </FocusBlock>
          )}

          {keys.includes("d-episodes") && (
            <FocusBlock focusKey="d-episodes" onEnter={scrollTo(false)} className="pb-12">
              <div className="flex items-baseline">
                {rowTitle(t("catalog.tv.episodes"), n++)}
                {seasonQ.data && <span className="ml-4 text-[24px] text-muted">{t("catalog.detail.episodes_count", { n: episodes.length })}</span>}
                {seasonQ.data && mp && <span className="ml-8 text-[20px] text-muted">{t("tv.watch.hold_options")}</span>}
              </div>
              {seasonQ.isPending || episodes.length === 0 ? (
                seasonQ.isError ? (
                  <ErrorState focusKey="d-ep-retry" error={seasonQ.error} onRetry={() => void seasonQ.refetch()} className="py-10" />
                ) : (
                  <div className="py-6">
                    <RowSkeleton title={false} count={4} width={420} height={236} />
                  </div>
                )
              ) : (
                <HRow
                  key={seasonNo ?? -1}
                  focusKey={`d-episodes-row-${seasonNo}`}
                  items={episodes}
                  itemKey={(e) => cardKey("ep", e.id)}
                  itemWidth={420}
                  itemHeight={420}
                  gap={cards.gap}
                  viewport={1920 - frame.x}
                  initialIndex={focusEpisodeIndex(episodes, {
                    remembered: mem.get<number>(`idx-ep-${seasonNo}`),
                    played: played?.season === seasonNo ? played : null,
                    requested: seasonNo === requestedSeason ? requestedEpisode : undefined,
                    suggestedId: suggested?.id,
                  })}
                  onIndexChange={(i) => mem.set(`idx-ep-${seasonNo}`, i)}
                  onSelect={(e) => play(e, "pick")}
                  onLongPress={mp ? (e) => episodeOptions(e) : undefined}
                  renderItem={(e, focused) => (
                    <EpisodeCard
                      ep={e}
                      cfg={cfg.data}
                      focused={focused}
                      locale={locale}
                      design={design}
                      progress={episodeProgress(mp, e.id)}
                      nextUp={suggested?.id === e.id}
                      spoilerFree={settings.spoiler_free_episodes && !!mp}
                      server={dlLabel(findDownload(downloads.data, { episodeId: e.id }))}
                    />
                  )}
                />
              )}
            </FocusBlock>
          )}

          {cast.length > 0 && (
            <FocusBlock focusKey="d-cast" onEnter={scrollTo(false)} className="pb-12">
              {rowTitle(t("catalog.detail.cast"), n++)}
              {castRow("d-cast")}
            </FocusBlock>
          )}
          {sim.length > 0 && (
            <FocusBlock focusKey="d-similar" onEnter={scrollTo(false)} className="pb-12">
              {rowTitle(t("tvd.tab.similar"), n++)}
              {mediaRow("d-similar", sim, base?.title ?? "")}
            </FocusBlock>
          )}
          {rec.length > 0 && (
            <FocusBlock focusKey="d-recs" onEnter={scrollTo(false)} className="pb-12">
              {rowTitle(t("catalog.detail.recommendations"), n++)}
              {mediaRow("d-recs", rec, base?.title ?? "")}
            </FocusBlock>
          )}
          {d && (
            <div className="pb-12">
              {rowTitle(t("tvd.tab.about"), n)}
              <About d={d} locale={locale} />
            </div>
          )}
          <div className="h-[400px]" />
        </div>
      </FocusLine>
      {menu && <ActionMenu title={menu.title} subtitle={menu.subtitle} actions={menu.actions} testId={menu.testId} onCancel={() => setMenu(null)} />}
      {trailer && d?.trailer && <TrailerLayer video={d.trailer} onClose={() => setTrailer(false)} />}
      {awardsOpen && d?.awards?.length ? <AwardsPanel title={d.title} awards={d.awards} onClose={() => setAwardsOpen(false)} /> : null}
      {triviaOpen === "quotes" && d && <QuotesPanel title={d.title} q={quotesQ} onClose={() => setTriviaOpen(null)} />}
      {triviaOpen === "facts" && d && <FactsPanel title={d.title} q={factsQ} onClose={() => setTriviaOpen(null)} />}
      {companionOpen === "recap" && d && (
        <RecapPanel id={d.id} title={d.title} profileId={profile.id} lastWatched={companionQ.data?.recap.last_watched_at ?? null} onClose={() => setCompanionOpen(null)} />
      )}
      {companionOpen === "after" && d && companionQ.data && (
        <AfterCreditsPanel
          id={d.id}
          title={d.title}
          profileId={profile.id}
          scope={companionQ.data.after_credits.scope}
          season={companionQ.data.after_credits.season ?? null}
          onClose={() => setCompanionOpen(null)}
        />
      )}
      {soundtrackOpen && d && <SoundtrackPanel mediaId={d.id} title={d.title} onClose={() => setSoundtrackOpen(false)} />}
      {onlineOpen && d && (
        <OnlinePicker
          title={d.title}
          season={isSeries ? (onlineQ?.season ?? null) : null}
          items={onlineItems}
          knownEpisodes={(seasonQ.data?.episodes ?? []).map((e) => e.episode_number)}
          wantedEpisode={ep && ep.season_number === onlineQ?.season ? ep.episode_number : null}
          onPlay={playOnline}
          onClose={() => setOnlineOpen(false)}
        />
      )}
    </div>
  );
}

/** «Подробно»: the facts that don't fit the header. */
function About({ d, locale }: { d: MediaDetail; locale: string }) {
  const { t } = useI18n();
  const directors = d.crew.filter((c) => c.job === (d.kind === "series" ? "Creator" : "Director")).map((c) => c.name);
  const rows: [string, string | null][] = [
    [d.kind === "series" ? t("catalog.detail.creator") : t("catalog.detail.director"), directors.slice(0, 3).join(", ") || null],
    [t("tvd.about.original"), d.original_title !== d.title ? d.original_title : null],
    [t("tvd.about.released"), formatDate(d.release_date, locale)],
    [t("tvd.about.countries"), d.countries.join(", ") || null],
    [t("tvd.about.language"), d.original_language ? d.original_language.toUpperCase() : null],
    [t("tvd.about.status"), d.status || null],
    [t("tvd.about.episodes"), d.number_of_episodes ? String(d.number_of_episodes) : null],
    [t("catalog.detail.cast"), d.cast.slice(0, 6).map((c) => c.name).join(", ") || null],
  ];
  return (
    <dl data-testid="about" className="w-[1400px] text-[25px] leading-snug">
      {rows
        .filter((r) => r[1])
        .map(([k, v]) => (
          <div key={k} className="mb-3 flex">
            <dt className="w-[340px] shrink-0 text-muted">{k}</dt>
            <dd className="truncate">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

function HeaderSkeleton({ design }: { design: Design }) {
  return (
    <div className="relative" style={{ height: HEADER_H[design] }}>
      <div className="absolute left-[168px] top-[160px] w-[900px]">
        <div className="h-6 w-[200px] rounded bg-surface-2 tv-pulse" />
        <div className="mt-6 h-20 w-[700px] rounded-xl bg-surface-2 tv-pulse" />
        <div className="mt-8 h-9 w-[400px] rounded-lg bg-surface tv-pulse" />
        <div className="mt-8 h-32 w-[860px] rounded-lg bg-surface tv-pulse" />
      </div>
    </div>
  );
}

function EpisodeCard({
  ep,
  cfg,
  focused,
  locale,
  design,
  progress,
  nextUp,
  spoilerFree,
  server,
}: {
  ep: Episode;
  cfg?: CatalogConfig;
  focused: boolean;
  locale: string;
  design: Design;
  progress: WatchProgress | null;
  nextUp: boolean;
  spoilerFree: boolean;
  server?: string | null;
}) {
  const { t } = useI18n();
  const runtime = formatRuntime(ep.runtime, locale);
  // Spoiler-free: stills and overviews of episodes not watched yet are blurred.
  const hide = spoilerFree && !progress?.completed;
  return (
    <div style={{ width: 420 }}>
      <div className="relative" style={{ width: 420, height: 236 }}>
      <div
        className={`tv-focus relative overflow-hidden ${design === "terminal" ? "" : "rounded-card"} ${focused ? "is-focused" : ""}`}
        style={{ width: 420, height: 236, background: legacyColor(placeholderColor(ep.id)) }}
      >
        <span className="absolute left-5 top-4 text-3xl font-bold text-text/70">{episodeCode(ep.season_number, ep.episode_number)}</span>
        <Img src={imageUrl(cfg, ep.still_path, "w300")} className={`absolute left-0 top-0 h-full w-full object-cover ${hide ? "tv-spoiler" : ""}`} />
        {nextUp && !progress?.completed && (
          <span data-next-up className="tv-check absolute left-3 top-3 rounded-full px-4 py-1 text-xl font-semibold">
            {t("tv.watch.next_up")}
          </span>
        )}
        <WatchBadges me={progress ? { progress_percent: progress.percent, completed: progress.completed, in_watchlist: false, favorite: false, rating: null } : undefined} />
      </div>
      {design === "terminal" && focused && <Brackets small />}
      </div>
      <p className={`mt-4 truncate text-[24px] ${focused ? "font-bold text-text" : "text-text"}`}>
        <span className="mr-3 text-accent">{episodeCode(ep.season_number, ep.episode_number)}</span>
        {ep.name}
      </p>
      {(runtime || server) && (
        <p className="mt-1 truncate text-xl text-muted">
          {runtime}
          {runtime && server ? " · " : ""}
          {server && <span data-on-server className="text-ok">{server}</span>}
        </p>
      )}
      <p className={`mt-2 line-clamp-3 text-xl leading-snug text-muted ${hide ? "tv-spoiler-text" : ""}`}>{ep.overview}</p>
    </div>
  );
}

function CastCard({ c, cfg, focused, design }: { c: CastMember; cfg?: CatalogConfig; focused: boolean; design: Design }) {
  return (
    <div style={{ width: 190 }}>
      <div
        className={`tv-focus relative overflow-hidden ${design === "terminal" ? "" : design === "projector" ? "rounded-full" : "rounded-card"} ${focused ? "is-focused" : ""}`}
        style={{ width: 190, height: design === "projector" ? 190 : 270, background: legacyColor(placeholderColor(c.name)) }}
      >
        <span className="absolute left-0 top-0 flex h-full w-full items-center justify-center text-6xl font-bold text-text/60">
          {c.name.trim()[0] ?? "?"}
        </span>
        <Img src={imageUrl(cfg, c.profile_path, "w185")} className="absolute left-0 top-0 h-full w-full object-cover" />
      </div>
      <p className={`mt-3 line-clamp-2 text-2xl leading-tight ${focused ? "font-semibold" : ""}`}>{c.name}</p>
      <p className="mt-1 line-clamp-2 text-xl leading-tight text-muted">{c.character}</p>
    </div>
  );
}

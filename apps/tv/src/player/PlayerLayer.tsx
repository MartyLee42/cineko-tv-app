import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { pause as pauseNav, resume as resumeNav } from "@noriginmedia/norigin-spatial-navigation";
import type { PlaybackSource, Release } from "@martytv/contracts";
import { chapterIndexAt, chapterTicks, fileChapters, imageUrl, nextChapterStart, prevChapterStart, releaseBitrate, skipMode, type Chapter } from "@martytv/media-types";
import { CvIcon, loadStatsLines, useAppliedDesign, useConstructivism, useI18n, useSlowTorrent, type MessageKey, type SlowTorrent } from "@martytv/ui";
import { FINALE_MS, hasFinale, loaderKind } from "./loaderChunks";
import { loaderKey } from "./loaderKeys";
import { FocusButton, FocusLine } from "../focus";
import { useCatalogConfig } from "../catalog/queries";
import { Backdrop } from "../components/Img";
import { player } from "./controller";
import { useFlow } from "./flow";
import { episodeLabel, formatClock, releaseRow } from "./format";
import { BufferingSpinner, Loader, useLoadProgress } from "./Loader";
import { useSteady } from "./steady";
import { getSource } from "./data";
import { mbit, prebufferPref } from "./rebuffer";
import { bufferStripe, netStats } from "./stats";
import { formatBytes, formatSpeed } from "./format";
import { useServerStatus } from "../design/data";
import { stageOf, TorrentHold, type LoadStage } from "./loading";
import { SLEEP_CHOICES, sleepChoiceOf, type SleepChoice, type SleepState } from "./sleep";
import { SleepOverlay, useSleepTimer } from "./SleepTimer";
import { useSettings } from "../profile/settings";
import { useSkip } from "./skip";
import { chapterSeek, playerKey, registerMediaKeys, type SeekPreview } from "./keys";
import { ReleasePicker } from "./ReleasePicker";
import { errorKey, type Flow, type PlayContext } from "./session";
import { PlayerChooser } from "../players/PlayerChooser";
import { claimKeys, type KeyClaim } from "../remote/keyOwner";
import { openMessageBanner } from "../messages/MessageLayer";

export { useFlow };

/** Everything playback shows over the catalog: picker, chooser, preparing, player, errors. */
export function PlayerLayer() {
  const flow = useFlow();
  switch (flow.phase) {
    case "idle":
      return null;
    case "picker":
      return <ReleasePicker ctx={flow.ctx} tried={flow.tried} />;
    case "choose":
      return <PlayerChooser ctx={flow.ctx} release={flow.release} />;
    case "failed":
      return <FailedScreen flow={flow} />;
    case "preparing":
    case "playing":
      if (flow.ctx.player && flow.ctx.player !== "builtin" && flow.phase === "playing") return <HandedOff ctx={flow.ctx} />;
      return <PlayerView flow={flow} />;
  }
}

/** Text for a flow error code. */
export function useErrorText() {
  const { t } = useI18n();
  return (code: string) => {
    const known = errorKey(code);
    if (known) return t(`player.error.${known}` as MessageKey);
    if (code === "no_releases") return t("player.no_releases");
    if (code === "timeout") return t("player.tv.error.timeout");
    if (code === "network") return t("player.tv.error.network");
    if (code === "msx_failed") return t("player.tv.error.msx_failed");
    if (code === "external_failed") return t("tvplay.ext.failed");
    return t("player.error.generic", { code });
  };
}

function Scene({ ctx, children, dim = 0.35 }: { ctx: PlayContext; children: React.ReactNode; dim?: number }) {
  const cfg = useCatalogConfig();
  return (
    <div className="absolute left-0 top-0 h-full w-full overflow-hidden bg-bg">
      <div className="absolute left-0 top-0 h-full w-full" style={{ opacity: dim }}>
        <Backdrop src={imageUrl(cfg.data, ctx.backdrop_path, "w1280")} />
      </div>
      <div className="tv-scrim-bottom absolute left-0 top-0 h-full w-full" />
      {children}
    </div>
  );
}

function TitleBlock({ ctx, className = "" }: { ctx: PlayContext; className?: string }) {
  const ep = episodeLabel(ctx.season, ctx.episode, ctx.episode_name);
  return (
    <div className={className}>
      <h1 className="truncate text-6xl font-bold leading-tight">{ctx.title || "…"}</h1>
      {ep && <p className="mt-3 truncate text-4xl text-muted">{ep}</p>}
    </div>
  );
}

function releaseSummary(r: Release | null, locale: string): string {
  if (!r) return "";
  const row = releaseRow(r, locale);
  return [row.resolution, ...row.chips, row.size].filter(Boolean).join(" · ");
}

/** The loading screen's quality line: the release, or the online source's quality and provider. */
function loadingQuality(r: Release | null, source: PlaybackSource | null | undefined, locale: string): string | null {
  if (source?.kind === "online") {
    const parts = [source.quality ? `${source.quality}p` : null, source.release?.title ?? null, source.provider?.name ?? null];
    return parts.filter(Boolean).join(" · ") || null;
  }
  return releaseSummary(r, locale) || null;
}

// ------------------------------------------------------------------ live torrent stats

/**
 * Peers/seeds/speed refreshed every 2 s while someone is looking at them
 * (loading screen, buffering, pause, the Down panel). The controller only
 * polls the source while TorrServer prepares it, so without this the
 * numbers froze once the source was ready.
 */
function useLiveTorrent(source: PlaybackSource | null | undefined, active: boolean): PlaybackSource["torrent"] | null {
  const id = source?.kind === "online" ? null : (source?.id ?? null);
  const q = useQuery({
    queryKey: ["tv-source-live", id],
    queryFn: () => getSource(id!),
    enabled: !!id && active,
    refetchInterval: active ? 2000 : false,
    staleTime: 1000,
    retry: false,
  });
  return (active && q.data?.torrent) || source?.torrent || null;
}

/** A torrent source still fetched from peers (not online, not a finished server download). */
function torrentSource(src: PlaybackSource | null | undefined): boolean {
  return !!src && (src.kind ?? "torrent") === "torrent" && src.download?.status !== "done";
}

/** What the release needs to play without stalls, bits/s (size over duration; the estimate when the length is unknown). */
function needBits(src: PlaybackSource | null | undefined): number | null {
  if (!src) return null;
  const size = src.file?.size_bytes ?? src.release?.size_bytes ?? null;
  const dur = src.media_info?.duration_seconds ?? src.duration_seconds ?? null;
  return releaseBitrate(size, dur) ?? src.release?.est_bitrate_bps ?? null;
}

/** «Раздача качается медленнее, чем нужно (0,4 из 0,6 МБ/с, 1 сид)» with «Другая раздача» / «Подождать» (Left/Right, OK; Back waits). */
function SlowTorrentHint({ slow, focus, className = "" }: { slow: SlowTorrent; focus: "another" | "wait"; className?: string }) {
  const { t, locale } = useI18n();
  return (
    <div data-testid="slow-torrent" className={`rounded-3xl bg-surface-2/95 px-10 py-7 text-text shadow-2xl ${className}`}>
      <p className="text-3xl font-semibold leading-snug">
        {t("load.slow", { speed: formatSpeed(slow.speedBps, locale), need: formatSpeed(slow.needBps, locale), seeders: slow.seeders })}
      </p>
      <p className="mt-2 text-2xl text-muted">{t("load.slow_hint")}</p>
      <div className="mt-5 flex items-center text-2xl">
        {(["another", "wait"] as const).map((id) => (
          <span
            key={id}
            data-testid={id === "another" ? "slow-torrent-another" : "slow-torrent-wait"}
            data-focused={focus === id ? "true" : "false"}
            className={`mr-6 rounded-xl px-6 py-3 font-semibold ${focus === id ? "bg-accent text-on-accent" : "bg-surface text-text"}`}
          >
            {t(id === "another" ? "load.slow_another" : "load.slow_wait")}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Peers · seeders · speed under «Буферизация…» while the player stalls mid-playback. */
function RebufferTorrent({ source }: { source: PlaybackSource }) {
  const { t, locale } = useI18n();
  const tor = useLiveTorrent(source, true);
  if (!tor || source.kind === "online" || source.download?.status === "done") return null;
  const lines = loadStatsLines({ stage: "rebuffering", torrent: tor }, { bytes: (n) => formatBytes(n, locale), speed: (b) => formatSpeed(b, locale) });
  return (
    <p data-testid="player-rebuffer-torrent" className="mt-2 text-2xl text-white/70 tabular-nums">
      {lines.map((l) => t(l.key, l.vars)).join("  ·  ")}
    </p>
  );
}

/** «1080p · Дубляж · 14,6 ГБ  ·  Пиров 14 · сидов 9 · 3,2 МБ/с» for the top of the player. */
function StatsLine({ source, release, active }: { source: PlaybackSource | null; release: Release | null; active: boolean }) {
  const { t, locale } = useI18n();
  const tor = useLiveTorrent(source, active);
  const quality = loadingQuality(release ?? source?.release ?? null, source, locale);
  const cs = player.compatState();
  const parts = [
    quality,
    cs.active && cs.video ? t("tvplay.compat.stats_video", { codec: cs.video }) : null,
    cs.active && cs.from ? t("tvplay.compat.stats", { codec: cs.from }) : null,
    tor ? t("player.tv.peers", { peers: tor.peers, seeders: tor.seeders }) : null,
    tor ? t("player.tv.speed", { speed: formatSpeed(tor.download_speed_bps, locale) }) : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <p data-testid="player-stats" className="mt-3 truncate text-2xl text-muted">
      {parts.join("  ·  ")}
    </p>
  );
}

/** The stats chips on the player overlay (playing or paused) and the Down panel: peers, server load, the link to this TV (parts that don't apply are hidden). */
function NetStatsPanel({ source }: { source: PlaybackSource }) {
  const { t, locale } = useI18n();
  const id = source.kind === "online" ? null : source.id;
  const live = useQuery({
    queryKey: ["tv-source-live", id],
    queryFn: () => getSource(id!),
    enabled: !!id,
    refetchInterval: 2000,
    staleTime: 1000,
    retry: false,
  });
  const status = useServerStatus();
  const src = live.data ?? source;
  const items = netStats(
    {
      kind: source.kind,
      torrent: src.torrent ?? null,
      local: src.download?.status === "done",
      cpu: status.data?.cpu_percent,
      streams: status.data?.active_streams,
      device: player.deviceRate(),
      frames: player.droppedFrames(),
    },
    (b) => formatSpeed(b, locale),
    mbit,
  );
  if (!items.length) return null;
  return (
    <div data-testid="player-netstats" className="mt-4 flex flex-wrap gap-3">
      {items.map((it) => (
        <span key={it.id} data-stat={it.id} className="rounded-full bg-black/55 px-5 py-1.5 text-2xl tabular-nums text-white/85">
          {t(it.key, it.vars)}
        </span>
      ))}
    </div>
  );
}

/** «Буфер 42 с · TorrServer 120 МБ» («Показывать буфер», off by default). */
function bufferLabel(t: ReturnType<typeof useI18n>["t"], locale: string, ahead: number, source: PlaybackSource): string {
  const pre = source.torrent?.preloaded_bytes ?? 0;
  return pre > 0 ? t("pstats.buffer_torrent", { ahead: Math.floor(ahead), size: formatBytes(pre, locale) }) : t("pstats.buffer", { ahead: Math.floor(ahead) });
}

// ------------------------------------------------------------------ preparing

/** One for the app, like the progress tracker (a remount keeps the numbers). */
const torrentHold = new TorrentHold();

/**
 * The end flourish of the drawn styles: true for FINALE_MS once a loading
 * screen that was up for a while (not a quick internal restart) gives way
 * to the first frame. Derived during render (no frame without the overlay).
 */
function useFinale(shown: boolean, playing: boolean): boolean {
  const [long, setLong] = useState(false);
  const [prev, setPrev] = useState(shown);
  const [finale, setFinale] = useState(false);
  if (prev !== shown) {
    setPrev(shown);
    setFinale(!shown && long && playing);
    setLong(false);
  }
  useEffect(() => {
    if (!shown) return;
    const id = setTimeout(() => setLong(true), 2000);
    return () => clearTimeout(id);
  }, [shown]);
  useEffect(() => {
    if (!finale) return;
    const id = setTimeout(() => setFinale(false), FINALE_MS);
    return () => clearTimeout(id);
  }, [finale]);
  return finale;
}

/** The first-load screen: preparing the source, then until the first frame (`done`: the style's end flourish). */
function PreparingOverlay({ flow, done = false }: { flow: Extract<Flow, { phase: "preparing" | "playing" }>; done?: boolean }) {
  const { locale } = useI18n();
  const cfg = useCatalogConfig();
  const settings = useSettings();
  const applied = useAppliedDesign();
  const ctx = flow.ctx;
  const stage: LoadStage = done ? "done" : flow.phase === "preparing" ? stageOf(flow.step, flow.source) : "starting";
  const source = flow.source;
  // While the first seconds buffer (source ready), keep the numbers live —
  // held so «загружено N МБ из M» never goes back.
  const live = useLiveTorrent(source, flow.phase === "playing");
  const held = torrentHold.hold(source?.id ?? null, live, source?.file?.size_bytes ?? source?.release?.size_bytes ?? null);
  const torrent = held.torrent;
  // The bar measures the same held numbers the text shows (one feed, not the raw polls).
  const fed = source ? { id: source.id, torrent, file: source.file, release: source.release } : null;
  const p = useLoadProgress(player.loadKey(), stage, fed, player.metadata, `${ctx.media_id}|${ctx.episode_id ?? ""}`);
  const cs = flow.phase === "playing" ? player.compatState() : null;
  // Tell phones following this load (device state) what the screen shows.
  const loadKey = player.loadKey();
  useEffect(() => player.reportLoad(loadKey, p, torrent), [loadKey, p, torrent]);
  if (done && !hasFinale(loaderKind(settings.loading_style, applied ?? "kinozal"))) return null;
  return (
    <Loader
      style={settings.loading_style}
      m={{
        done,
        p,
        stage,
        title: ctx.title,
        episode: episodeLabel(ctx.season, ctx.episode, ctx.episode_name),
        poster: imageUrl(cfg.data, ctx.poster_path, "w500"),
        backdrop: imageUrl(cfg.data, ctx.backdrop_path, "w1280"),
        seed: ctx.media_id,
        torrent,
        quality: loadingQuality(flow.release ?? source?.release ?? null, source, locale),
        fileBytes: held.fileBytes,
        compat: cs?.active ? (cs.video ? "video" : "audio") : null,
        online: source?.kind === "online" || (!!flow.release?.provider && flow.release.provider.kind !== "torrent"),
      }}
    />
  );
}

// ------------------------------------------------------------------ failed

function FailedScreen({ flow }: { flow: Extract<Flow, { phase: "failed" }> }) {
  const { t, locale } = useI18n();
  const errText = useErrorText();
  const next = player.nextCandidate();
  const unplayable = flow.kind === "unplayable";
  const reason = flow.code === "no_audio" ? t("player.tv.reason_no_audio", { codec: flow.reason ?? "?" }) : (flow.reason ?? "?");
  const keys = ["f-another", ...(next ? ["f-choose"] : []), "f-back"];
  return (
    <Scene ctx={flow.ctx} dim={0.25}>
      <div data-testid="player-failed" data-code={flow.code} className="absolute left-24 right-24 top-1/2 -translate-y-1/2">
        <TitleBlock ctx={flow.ctx} />
        <p className="mt-14 text-5xl font-bold text-accent-strong">{unplayable ? t("player.tv.cant_play") : t("player.tv.prepare_failed")}</p>
        <p data-testid="player-failed-text" className="mt-6 max-w-[1500px] text-4xl leading-snug">
          {unplayable ? t("player.unplayable", { reason }) : errText(flow.code)}
        </p>
        {flow.release && <p className="mt-6 truncate text-3xl text-muted">{releaseSummary(flow.release, locale)}</p>}
        <FocusLine focusKey="failed" keys={keys} axis="horizontal" className="mt-14 flex">
          <FocusButton
            focusKey="f-another"
            autoFocus
            onPress={() => player.tryAnother()}
            className="mr-8 rounded-2xl bg-accent px-12 py-6 text-4xl font-semibold text-on-accent"
          >
            {t("player.another_release")}
          </FocusButton>
          {next && (
            <FocusButton focusKey="f-choose" onPress={() => player.choose()} className="mr-8 rounded-2xl bg-surface-2 px-12 py-6 text-4xl">
              {t("player.choose_release")}
            </FocusButton>
          )}
          <FocusButton focusKey="f-back" onPress={() => player.close()} className="rounded-2xl bg-surface-2 px-12 py-6 text-4xl">
            {t("common.back")}
          </FocusButton>
        </FocusLine>
        {next && <p className="mt-10 truncate text-3xl text-muted">{t("player.tv.will_try", { release: releaseSummary(next, locale) })}</p>}
      </div>
    </Scene>
  );
}

// ------------------------------------------------------------------ handed off (MSX / external)

function HandedOff({ ctx }: { ctx: PlayContext }) {
  const { t } = useI18n();
  return (
    <Scene ctx={ctx}>
      <div data-testid="player-handed-off" className="absolute left-24 right-24 top-1/2 -translate-y-1/2">
        <TitleBlock ctx={ctx} />
        <p className="mt-14 text-5xl font-semibold text-accent">{ctx.player === "msx" ? t("player.tv.msx_playing") : t("player.tv.external_playing")}</p>
        <p className="mt-6 text-3xl text-muted">{t("player.tv.handoff_hint")}</p>
        <div className="mt-14 flex">
          <FocusButton focusKey="h-back" autoFocus onPress={() => player.close()} className="rounded-2xl bg-surface-2 px-12 py-6 text-4xl">
            {t("common.back")}
          </FocusButton>
        </div>
      </div>
    </Scene>
  );
}

// ------------------------------------------------------------------ the player

const CONTROLS_MS = 4500;
const PAUSED_CONTROLS_MS = 10_000;
const SEEK_COMMIT_MS = 700;
const COUNTDOWN = 10;
/** The next-episode card without a countdown (autoplay off). */
const MANUAL = -1;

interface PanelItem {
  group: "episode" | "audio" | "subtitles" | "quality" | "compat" | "sleep";
  id: string | null;
  label: string;
}

/** The sleep timer fired: a normal pause (the progress reporter saves the spot). */
const pauseForSleep = () => void player.pause();

function PlayerView({ flow }: { flow: Extract<Flow, { phase: "preparing" | "playing" }> }) {
  const { t, locale } = useI18n();
  const settings = useSettings();
  const autoplay = settings.autoplay_next_episode;
  // «Отсчёт перед следующим» off: the next episode starts at once (no card).
  const countdownOn = settings.autoplay_countdown;
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((n) => n + 1), []);
  const [controls, setControls] = useState(true);
  const [seek, setSeek] = useState<SeekPreview | null>(null);
  const [panel, setPanel] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [warnGone, setWarnGone] = useState<string | null>(null);
  /** The slow-link hint's focused button («Не сейчас» first: OK never leaves the film by surprise). */
  const [slowFocus, setSlowFocus] = useState<"lighter" | "not_now">("not_now");
  const slowFocusRef = useRef(slowFocus);
  useEffect(() => {
    slowFocusRef.current = slowFocus;
  });
  /** «Картинка подтормаживает…»: the same two buttons, «Не сейчас» first. */
  const [smoothFocus, setSmoothFocus] = useState<"lighter" | "not_now">("not_now");
  const smoothFocusRef = useRef(smoothFocus);
  useEffect(() => {
    smoothFocusRef.current = smoothFocus;
  });
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seekRef = useRef<SeekPreview | null>(null);
  const state = useRef({ controls, panel, countdown });
  useEffect(() => {
    state.current = { controls, panel, countdown };
  });
  const playing = flow.phase === "playing";
  const ctx = flow.ctx;

  // «Раздача качается медленнее, чем нужно»: while loading or rebuffering,
  // the torrent's speed stays under the release's bitrate (the data decides;
  // the controller only acts on «Другая раздача»).
  const loadingNow = flow.phase === "preparing" || !player.started;
  const rebufNow = playing && player.started && player.rebuffering() !== null;
  const finale = useFinale(loadingNow, playing);
  const liveTorrent = useLiveTorrent(flow.source, loadingNow || rebufNow);
  const [waitKey, setWaitKey] = useState<string | null>(null);
  const slowKey = `${player.loadKey()}:${loadingNow ? "load" : "rebuf"}`;
  const slowT = useSlowTorrent(liveTorrent, needBits(flow.source), (loadingNow || rebufNow) && torrentSource(flow.source) && waitKey !== slowKey);
  const [slowTFocus, setSlowTFocus] = useState<"another" | "wait">("another");
  const slowTRef = useRef<{ slow: SlowTorrent | null; focus: "another" | "wait"; key: string }>({ slow: null, focus: "another", key: "" });
  useEffect(() => {
    slowTRef.current = { slow: slowT, focus: slowTFocus, key: slowKey };
  });

  // The player owns the remote: spatial navigation pauses while it's shown
  // (overlays on top — a message, a rating — claim the keys after it).
  const claim = useRef<KeyClaim | null>(null);
  useEffect(() => {
    pauseNav();
    const c = claimKeys();
    claim.current = c;
    const unregister = registerMediaKeys();
    return () => {
      c.release();
      unregister();
      resumeNav();
    };
  }, []);

  const videoRef = useCallback((v: HTMLVideoElement | null) => {
    if (v) player.attach(v);
    else player.detach();
  }, []);
  const frameRef = useCallback((c: HTMLCanvasElement | null) => player.attachFrame(c), []);

  useEffect(() => player.subscribe((k) => (k === "playback" || k === "progress") && rerender()), [rerender]);

  // Progress bar ticks while controls are visible.
  useEffect(() => {
    if (!controls && !seek) return;
    const id = setInterval(rerender, 500);
    return () => clearInterval(id);
  }, [controls, seek, rerender]);
  // Online sources with an opening marker: the skip pill follows the position.
  const hasMarkers = flow.phase === "playing" && (flow.source.markers?.length ?? 0) > 0;
  useEffect(() => {
    if (!hasMarkers) return;
    const id = setInterval(rerender, 1000);
    return () => clearInterval(id);
  }, [hasMarkers, rerender]);

  const v = player.video;
  // «Таймер сна»: per playback session (this view), see SleepTimer.tsx.
  const sleep = useSleepTimer(v, pauseForSleep, setNote);
  const sleepRef = useRef(sleep);
  // «Заставки и титры»: skip pill, auto-skip with «Вернуть», next episode at the credits.
  const skip = useSkip({
    active: playing && player.started,
    mode: skipMode(settings.skip_segments),
    ending: playing && ctx.kind === "series" && sleep.state.mode !== "episode" && !!player.nextRef(),
    playKey: `${flow.source?.id ?? ""}|${ctx.season ?? ""}|${ctx.episode ?? ""}`,
    autoplay,
    startCountdown: () => {
      if (!countdownOn) {
        if (!player.nextEpisode()) player.close();
      } else setCountdown((c) => c ?? COUNTDOWN);
    },
    nextEpisode: () => {
      setCountdown(null);
      if (!player.nextEpisode()) player.close();
    },
  });
  const skipRef = useRef(skip);
  useEffect(() => {
    skipRef.current = skip;
  });
  useEffect(() => {
    sleepRef.current = sleep;
  });
  // Rebuffering pauses the element itself: that's not the user's pause.
  const paused = playing && player.userPaused();
  // Up hides the overlay even while paused (to look at the frame); any key
  // that shows controls brings it back.
  const [hush, setHush] = useState(false);
  const [hushPaused, setHushPaused] = useState(paused);
  if (hushPaused !== paused) {
    // Pause/resume (also from the phone) shows the overlay again.
    setHushPaused(paused);
    if (hush) setHush(false);
  }
  const hushRef = useRef(false);
  useEffect(() => {
    hushRef.current = hush;
  });
  const controlsShown = !hush && (controls || paused);
  // Paused: the overlay also hides after PAUSED_CONTROLS_MS without a key
  // (any key brings it back), so a paused frame isn't covered for good.
  const [keyTick, setKeyTick] = useState(0);
  useEffect(() => {
    if (!paused || !controlsShown) return;
    const id = setTimeout(() => setHush(true), PAUSED_CONTROLS_MS);
    return () => clearTimeout(id);
  }, [paused, controlsShown, keyTick]);
  const showControls = useCallback(() => {
    setKeyTick((n) => n + 1);
    setHush(false);
    setControls(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!player.userPaused()) setControls(false);
    }, CONTROLS_MS);
  }, []);
  // Controls start visible and hide after a while (they stay while paused).
  // Also on resume (OK, the phone, after a rebuffer): a timer that fired while
  // paused kept them, so arm a new one. «Paused» is the viewer's pause, not
  // the element's (rebuffering / a seek pause it too).
  useEffect(() => {
    if (!playing || paused) return;
    hideTimer.current = setTimeout(() => {
      if (!player.userPaused()) setControls(false);
    }, CONTROLS_MS);
    return () => clearTimeout(hideTimer.current);
  }, [playing, paused]);

  // Early warning: the TV probably can't decode this file (still tries).
  // Not while the server converts it (compat: audio → AAC, video → H.264).
  const sourceId = playing ? flow.source.id : null;
  const support = player.support;
  const converting = playing && player.compatState().active;
  const warn = sourceId && warnGone !== sourceId && !converting && support && support.verdict !== "ok" ? support.unsupported : null;
  useEffect(() => {
    if (!sourceId) return;
    const id = setTimeout(() => setWarnGone(sourceId), 9000);
    return () => clearTimeout(id);
  }, [sourceId]);

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 3500);
    return () => clearTimeout(id);
  }, [note]);

  // End of an episode: countdown to the next one; a movie returns to Details.
  useEffect(() => {
    if (!v) return;
    // Autoplay off: the "next episode" card waits for OK (no countdown).
    const onEnded = () => {
      // A cut-off stream also fires "ended": the controller recovers it.
      if (!player.endedForReal()) return;
      // «После этой серии»: the goodnight screen instead of the next one.
      if (sleepRef.current.atEpisodeEnd()) return;
      if (ctx.kind === "series" && player.nextRef()) {
        if (autoplay && !countdownOn) {
          if (!player.nextEpisode()) player.close();
        } else setCountdown(autoplay ? COUNTDOWN : MANUAL);
      } else player.close();
    };
    v.addEventListener("ended", onEnded);
    return () => v.removeEventListener("ended", onEnded);
  }, [v, ctx.kind, autoplay, countdownOn]);
  useEffect(() => {
    if (countdown === null || countdown === MANUAL) return;
    const id = setTimeout(() => {
      if (countdown > 1) return setCountdown(countdown - 1);
      setCountdown(null);
      if (!player.nextEpisode()) player.close();
    }, 1000);
    return () => clearTimeout(id);
  }, [countdown]);

  const tracks = playing ? player.tracks() : null;
  const qualities = playing ? player.qualities() : null;
  const compat = playing ? player.compatState() : null;
  // Series: «Предыдущая / Следующая серия» first in the ▼ panel (when they exist).
  const prevEp = playing && ctx.kind === "series" ? player.prevRef() : null;
  const nextEp = playing && ctx.kind === "series" ? player.nextRef() : null;
  const epItems: PanelItem[] = [
    ...(prevEp ? [{ group: "episode" as const, id: "prev", label: `⏮  ${t("player.prev_episode")} · ${episodeLabel(prevEp.season, prevEp.episode, prevEp.name)}` }] : []),
    ...(nextEp ? [{ group: "episode" as const, id: "next", label: `${t("player.next_episode")} · ${episodeLabel(nextEp.season, nextEp.episode, nextEp.name)}  ⏭` }] : []),
  ];
  const items: PanelItem[] = tracks
    ? [
        ...epItems,
        ...tracks.audio.map((a) => ({ group: "audio" as const, id: a.id, label: a.label })),
        // «Совместимый звук (AAC)»: the server converts the audio (auto / on / off).
        ...(compat?.available
          ? (["auto", "on", "off"] as const).map((p) => ({ group: "compat" as const, id: p, label: t(`tvplay.compat.${p}`) }))
          : []),
        { group: "subtitles" as const, id: null, label: t("player.subtitles_off") },
        ...tracks.subtitles.map((s) => ({ group: "subtitles" as const, id: s.id, label: s.label })),
        ...(qualities?.list ?? []).map((q) => ({ group: "quality" as const, id: String(q), label: `${q}p` })),
        // «Таймер сна»: «После этой серии» only for series.
        ...SLEEP_CHOICES.filter((c) => c !== "episode" || ctx.kind === "series").map((c) => ({
          group: "sleep" as const,
          id: String(c),
          label: c === "off" ? t("sleep.off") : c === "episode" ? t("sleep.episode") : t("sleep.minutes", { n: c }),
        })),
      ]
    : [];
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });
  // The file's chapters (ffprobe, media_info): ticks, the title by the time, ◀▶ stop at their starts.
  const chapters = playing ? fileChapters(flow.source.media_info?.chapters, player.duration()) : null;
  const chaptersRef = useRef<Chapter[] | null>(chapters);
  useEffect(() => {
    chaptersRef.current = chapters;
  });

  const commitSeek = useCallback(() => {
    const s = seekRef.current;
    seekRef.current = null;
    setSeek(null);
    if (s) player.seekTo(s.target);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (claim.current && !claim.current.top) return;
      const k = playerKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopPropagation();
      // Any key restarts the paused overlay's 10 s auto-hide.
      setKeyTick((n) => n + 1);
      // Sleep timer: a key wakes the goodnight screen (to the paused player) or extends the dim.
      if (sleepRef.current.onKey()) return showControls();
      const st = state.current;
      const sl = slowTRef.current;
      if (sl.slow && !seekRef.current && st.panel === null) {
        if (k === "left" || k === "right") return setSlowTFocus(k === "left" ? "another" : "wait");
        if (k === "back" || (k === "ok" && sl.focus === "wait")) return setWaitKey(sl.key);
        if (k === "ok") return player.slowAnother(sl.slow.speedBps * 8);
      }
      // «Лови!»: the loading screen's game takes the arrows (Back / OK / media keys stay the player's).
      if (player.loading() && loaderKey(k)) return;
      if (flow.phase !== "playing") {
        if (k === "back") player.back();
        if (k === "stop") player.close();
        return;
      }
      if (st.countdown !== null) {
        if (k === "ok" || k === "next" || k === "play" || k === "playpause") {
          setCountdown(null);
          if (!player.nextEpisode()) player.close();
        } else if (k === "back" || k === "stop") {
          setCountdown(null);
          showControls();
        }
        return;
      }
      if (st.panel !== null) {
        const list = itemsRef.current;
        if (k === "up") setPanel(Math.max(0, st.panel - 1));
        else if (k === "down") setPanel(Math.min(list.length - 1, st.panel + 1));
        else if (k === "back" || k === "left" || k === "right") {
          setPanel(null);
          // Paused: the panel goes away without the pause overlay coming back
          // (the next Back leaves, as it would before the panel was opened).
          if (player.userPaused()) setHush(true);
        }
        else if (k === "ok") {
          const it = list[st.panel];
          if (!it) return;
          if (it.group === "episode") {
            setPanel(null);
            if (it.id === "prev") player.prevEpisode();
            else player.nextEpisode();
            return;
          }
          if (it.group === "compat") {
            player.setCompatPref(it.id as "auto" | "on" | "off");
            return;
          }
          if (it.group === "sleep") {
            const c = (it.id === "off" || it.id === "episode" ? it.id : Number(it.id)) as SleepChoice;
            setNote(sleepRef.current.choose(c));
            return;
          }
          if (it.group === "quality") {
            const q = Number(it.id);
            void player.setQuality(q).then((ok) => setNote(ok ? t("sources.tv.quality_note", { q: `${q}p` }) : t("sources.player.quality_failed")));
            return;
          }
          const r = it.group === "audio" ? player.setAudio(it.id!) : player.setSubtitles(it.id);
          if (r === "unsupported") setNote(t("player.tv.tracks_unsupported"));
          else if (r === true && it.group === "audio" && player.compatState().active) setNote(t("tvplay.compat.switching"));
        }
        return;
      }
      // «Скорость соединения ниже…» owns OK / Back / Left / Right while shown
      // (≤ 15 s): Left/Right pick «Выбрать раздачу полегче» / «Не сейчас»
      // (the default), OK runs the focused one, Back dismisses. Up/Down,
      // «Совместимый звук» off but this audio can't play here: OK turns it back on.
      if (k === "ok" && !seekRef.current && st.panel === null && player.compatOffBlocks()) return player.enableCompatNow();
      // play/pause and the rest still reach the player.
      if (player.slowHint() && !seekRef.current) {
        if (k === "back") return player.dismissSlow();
        if (k === "left" || k === "right") {
          player.touchSlow();
          return setSlowFocus(k === "left" ? "lighter" : "not_now");
        }
        if (k === "ok") return slowFocusRef.current === "lighter" ? player.lighter() : player.dismissSlow();
      }
      // «Картинка подтормаживает…»: the same keys (≤ 20 s, Back dismisses).
      if (player.stutterHint() && !seekRef.current) {
        if (k === "back") return player.dismissStutter();
        if (k === "left" || k === "right") {
          player.touchStutter();
          return setSmoothFocus(k === "left" ? "lighter" : "not_now");
        }
        if (k === "ok") return smoothFocusRef.current === "lighter" ? void player.smoother() : player.dismissStutter();
      }
      switch (k) {
        case "ok":
        case "playpause":
          if (seekRef.current) return commitSeek();
          // «Буферизация…»: OK plays now.
          if (player.resumeNow()) return showControls();
          // An intro / recap / credits range (or «Вернуть» after an auto-skip): OK acts on it.
          if (k === "ok" && skipRef.current.onOk()) return showControls();
          player.toggle();
          return showControls();
        case "play":
          player.resume();
          return showControls();
        case "pause":
          player.pause();
          return showControls();
        case "stop":
          return player.close();
        case "left":
        case "right":
        case "rew":
        case "ff": {
          const dir = k === "left" || k === "rew" ? -1 : 1;
          const next = chapterSeek(seekRef.current, player.position(), dir, player.duration(), chaptersRef.current);
          seekRef.current = next;
          setSeek(next);
          showControls();
          clearTimeout(seekTimer.current);
          seekTimer.current = setTimeout(commitSeek, SEEK_COMMIT_MS);
          return;
        }
        case "up": {
          // Up toggles the controls / progress bar (paused: the whole pause
          // overlay, to look at the frame).
          const paused = !!player.video?.paused;
          const visible = paused ? !hushRef.current : st.controls;
          if (!visible) return showControls();
          clearTimeout(hideTimer.current);
          setControls(false);
          if (paused) setHush(true);
          return;
        }
        case "down": {
          if (openMessageBanner()) return;
          const cur = itemsRef.current;
          const sel = player.tracks();
          // Series: start on «Следующая серия» (else the previous one); films: the current audio.
          const epAt = cur.findIndex((i) => i.group === "episode" && i.id === "next");
          const firstEp = cur.findIndex((i) => i.group === "episode");
          const at = epAt >= 0 ? epAt : firstEp >= 0 ? firstEp : Math.max(0, cur.findIndex((i) => i.group === "audio" && i.id === sel.audioId));
          setPanel(at);
          setControls(false);
          return;
        }
        case "next":
        case "prev": {
          if (ctx.kind === "series") return k === "next" ? player.nextEpisode() : player.prevEpisode();
          // A film: ⏭ / ⏮ jump to the next / previous chapter (the current one's start first, like a CD player).
          const cs = chaptersRef.current;
          const to = k === "next" ? nextChapterStart(cs, player.position()) : prevChapterStart(cs, player.position());
          if (to === null) return;
          clearTimeout(seekTimer.current);
          seekRef.current = null;
          setSeek(null);
          player.seekTo(to);
          return showControls();
        }
        case "back":
          // Still loading (no picture yet): Back cancels at once.
          if (player.loading()) return player.close();
          if (seekRef.current) {
            clearTimeout(seekTimer.current);
            seekRef.current = null;
            return setSeek(null);
          }
          // Paused: the first Back folds the pause overlay (controls + badge),
          // the next one leaves. Playing: Back hides the controls first.
          if (player.userPaused() && !hushRef.current) {
            clearTimeout(hideTimer.current);
            setControls(false);
            return setHush(true);
          }
          if (st.controls && !player.userPaused()) {
            clearTimeout(hideTimer.current);
            return setControls(false);
          }
          return player.close();
        default:
          return;
      }
    };
    // Capture: the player sees keys before the app's Back handler.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [flow.phase, ctx.kind, showControls, commitSeek, t]);

  useEffect(() => () => clearTimeout(seekTimer.current), []);

  const pos = seek ? seek.target : player.position();
  const dur = player.duration();
  const rebuf = playing ? player.rebuffering() : null;
  const slow = playing ? player.slowHint() : null;
  const compatOff = playing ? player.compatOffBlocks() : null;
  // Each time the hint appears, «Не сейчас» is focused again.
  const slowShown = !!slow;
  const [slowWasShown, setSlowWasShown] = useState(slowShown);
  if (slowWasShown !== slowShown) {
    setSlowWasShown(slowShown);
    if (slowShown && slowFocus !== "not_now") setSlowFocus("not_now");
  }
  const stutter = playing && !slow && player.stutterHint();
  const [stutterWasShown, setStutterWasShown] = useState(stutter);
  if (stutterWasShown !== stutter) {
    setStutterWasShown(stutter);
    if (stutter && smoothFocus !== "not_now") setSmoothFocus("not_now");
  }
  const ticks = chapterTicks(chapters, dur);
  const chapterAt = chapterIndexAt(chapters, pos);
  const chapterText =
    chapters && chapterAt >= 0
      ? chapters[chapterAt]!.title
        ? t("chapters.titled", { n: chapterAt + 1, title: chapters[chapterAt]!.title! })
        : t("chapters.n", { n: chapterAt + 1 })
      : null;
  const bufferingNow = playing && (player.recovering() || !!rebuf || player.compatRestarting() || ((!v || v.seeking || v.readyState < 3) && !paused && !player.quietStall()));
  // After a seek (esp. backwards) seeking / readyState flap several times a
  // second: show the spinner / «Буферизация» only once it lasts, hide it once
  // playback has really resumed; nothing while ◀▶ are still choosing a position.
  const buffering = useSteady(bufferingNow && !seek);
  const rebufShown = useSteady(!!rebuf && !seek);
  const pct = dur ? Math.max(0, Math.min(100, (pos / dur) * 100)) : 0;
  const playedPct = dur ? Math.max(0, Math.min(100, (player.position() / dur) * 100)) : 0;
  const ep = episodeLabel(ctx.season, ctx.episode, ctx.episode_name);
  const skipKind = skip.marker?.kind ?? null;
  // Anime keeps «опенинг».
  const anime = flow.phase === "playing" && flow.source.provider?.kind === "anime";
  // «Показывать буфер»: read on each render (Settings may change it between plays).
  const ahead = playing && prebufferPref.get() ? player.bufferAhead() : null;
  const stripe = bufferStripe(player.position(), ahead, dur);

  return (
    <div
      data-testid="player"
      data-paused={paused ? "1" : "0"}
      data-compat={compat?.active ? "on" : "off"}
      data-compat-video={compat?.video ? "on" : "off"}
      data-rebuffering={rebuf ? "true" : "false"}
      className="absolute left-0 top-0 h-full w-full overflow-hidden bg-black"
    >
      <video ref={videoRef} className="absolute left-0 top-0 h-full w-full" style={{ objectFit: "contain" }} preload="auto" playsInline>
        {/* Online sources: external subtitles (proxied VTT). */}
        {flow.phase === "playing" &&
          (flow.source.subtitles ?? []).map((s, i) => (
            <track key={s.url} kind="subtitles" src={s.url} srcLang={s.lang ?? undefined} label={s.label ?? s.lang ?? `#${i + 1}`} />
          ))}
      </video>
      {/* The last picture while a new stream loads mid-film (compat seek, reload): no black screen. */}
      <canvas
        ref={frameRef}
        data-testid="player-held-frame"
        className="absolute left-0 top-0 h-full w-full"
        style={{ objectFit: "contain", display: player.frameShown() ? "block" : "none" }}
      />

      {loadingNow ? <PreparingOverlay flow={flow} /> : finale && <PreparingOverlay flow={flow} done />}
      {slowT && (flow.phase === "preparing" || !player.started) && (
        <div className="absolute bottom-[90px] left-1/2 z-20 w-[1400px] -translate-x-1/2">
          <SlowTorrentHint slow={slowT} focus={slowTFocus} />
        </div>
      )}

      {buffering && player.started && !rebufShown && <BufferingSpinner />}
      {/* Where it is loading (a seek's target) — big, under the spinner, while the controls are hidden. */}
      {buffering && player.started && !rebufShown && !controlsShown && !seek && panel === null && (
        <p data-testid="player-loading-at" className="absolute left-1/2 top-1/2 mt-20 -translate-x-1/2 rounded-xl bg-black/60 px-5 py-1 text-4xl font-semibold tabular-nums">
          {formatClock(player.position())}
        </p>
      )}
      {rebufShown && rebuf && player.started && (
        <div data-testid="player-rebuffer" data-pct={rebuf.pct} className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-black/70 px-12 py-8 text-center">
          <p className="text-5xl font-semibold tabular-nums">{t("tvplay.rebuffer", { pct: rebuf.pct })}</p>
          <p data-testid="player-rebuffer-stats" className="mt-3 text-2xl text-white/70 tabular-nums">
            {t("tvplay.rebuffer_stats", { ahead: Math.floor(rebuf.ahead), rate: rebuf.rate ? mbit(rebuf.rate) : "…" })}
          </p>
          {flow.phase === "playing" && <RebufferTorrent source={flow.source} />}
          {slowT && <SlowTorrentHint slow={slowT} focus={slowTFocus} className="mt-6 text-left" />}
          {!slow && <p className="mt-5 text-2xl text-white/80">{t("tvplay.rebuffer_ok")}</p>}
        </div>
      )}
      {slow && panel === null && countdown === null && (
        <div data-testid="player-slow" className="absolute bottom-[300px] left-1/2 z-10 w-[1300px] -translate-x-1/2 rounded-3xl bg-surface-2/95 px-10 py-7 shadow-2xl">
          <p className="text-3xl leading-snug">{t("tvplay.slow.text", { rate: mbit(slow.rate), bitrate: mbit(slow.bitrate) })}</p>
          <div className="mt-5 flex items-center text-2xl">
            {(["lighter", "not_now"] as const).map((id) => (
              <span
                key={id}
                data-testid={id === "lighter" ? "player-slow-lighter" : "player-slow-dismiss"}
                data-focused={slowFocus === id ? "true" : "false"}
                className={`mr-6 rounded-xl px-6 py-3 font-semibold ${slowFocus === id ? "bg-accent text-on-accent" : "bg-surface text-text"}`}
              >
                {t(id === "lighter" ? "tvplay.slow.lighter" : "tvplay.slow.not_now")}
              </span>
            ))}
            <span className="text-muted">Back · {t("tvplay.slow.dismiss")}</span>
          </div>
        </div>
      )}
      {stutter && panel === null && countdown === null && (
        <div data-testid="player-stutter" className="absolute bottom-[300px] left-1/2 z-10 w-[1300px] -translate-x-1/2 rounded-3xl bg-surface-2/95 px-10 py-7 shadow-2xl">
          <p className="text-3xl leading-snug">{t("smooth.hint")}</p>
          <div className="mt-5 flex items-center text-2xl">
            {(["lighter", "not_now"] as const).map((id) => (
              <span
                key={id}
                data-testid={id === "lighter" ? "player-stutter-lighter" : "player-stutter-dismiss"}
                data-focused={smoothFocus === id ? "true" : "false"}
                className={`mr-6 rounded-xl px-6 py-3 font-semibold ${smoothFocus === id ? "bg-accent text-on-accent" : "bg-surface text-text"}`}
              >
                {t(id === "lighter" ? "smooth.lighter" : "smooth.not_now")}
              </span>
            ))}
            <span className="text-muted">Back · {t("smooth.dismiss")}</span>
          </div>
        </div>
      )}
      {compat?.active && player.started && (controlsShown || panel !== null) && countdown === null && (
        <div data-testid="player-compat" className="absolute right-24 top-16 z-10 rounded-full bg-surface-2/90 px-6 py-2 text-2xl text-text">
          {compat.video ? `▶ ${t("tvplay.compat.osd_video")}` : `♪ ${t("tvplay.compat.osd")}`}
        </div>
      )}

      {playing && player.started && paused && !hush && !seek && panel === null && (
        <div data-testid="player-pause-badge" className="tv-pause-badge absolute left-1/2 top-1/2 flex h-40 w-40 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-6xl">
          <PauseIcon size={72} />
        </div>
      )}

      {compatOff && panel === null && countdown === null && (
        <div data-testid="player-compat-off" className="absolute bottom-[160px] left-1/2 z-30 w-[1300px] -translate-x-1/2 rounded-3xl bg-surface-2/95 px-10 py-7 shadow-2xl">
          <p className="text-3xl leading-snug">{t(compatOff.kind === "video" ? "tvplay.compat.off_bad_video" : "tvplay.compat.off_bad", { codec: compatOff.codec })}</p>
          <p className="mt-4 text-2xl">
            <span className="mr-4 rounded-xl bg-accent px-5 py-2 font-semibold text-on-accent">OK</span>
            {t(compatOff.kind === "video" ? "tvplay.compat.enable_video" : "tvplay.compat.enable")}
          </p>
        </div>
      )}
      {warn && (
        <div data-testid="player-warning" className="absolute left-1/2 top-12 z-10 -translate-x-1/2 rounded-3xl bg-surface-2/95 px-10 py-5 text-3xl text-accent-strong shadow-2xl">
          ⚠ {t("player.tv.may_not_play", { list: warn.join(", ") })}
        </div>
      )}

      {playing && player.started && (controlsShown || seek) && panel === null && countdown === null && (
        <div data-testid="player-controls" className="absolute left-0 top-0 h-full w-full">
          <div className="tv-scrim-top absolute left-0 right-0 top-0 h-[300px]" />
          <div className="absolute left-24 right-24 top-16">
            <h1 className="truncate text-5xl font-bold">{ctx.title}</h1>
            {ep && <p className="mt-2 truncate text-3xl text-muted">{ep}</p>}
            {(prevEp || nextEp) && (
              <p data-testid="player-episode-nav" className="mt-3 flex gap-4 text-2xl text-muted">
                {prevEp && <span className="rounded-full bg-text/10 px-4 py-1">⏮ {episodeLabel(prevEp.season, prevEp.episode)}</span>}
                {nextEp && <span className="rounded-full bg-text/10 px-4 py-1">{episodeLabel(nextEp.season, nextEp.episode)} ⏭</span>}
                <span className="py-1">{t("player.tv.episodes_hint")}</span>
              </p>
            )}
            {/* Live peers / speed / load whenever the overlay is up, playing or paused. */}
            <StatsLine source={flow.source} release={flow.release} active />
            <NetStatsPanel source={flow.source} />
          </div>
          <div className="tv-scrim-bottom-strong absolute bottom-0 left-0 right-0 h-[380px]" />
          <div className="absolute bottom-16 left-24 right-24">
            <div className="flex items-end justify-between text-3xl">
              <span className="flex items-center">
                <span className="mr-6 flex h-16 w-16 items-center justify-center rounded-full bg-text text-bg">{paused ? <PlayIcon size={30} /> : <PauseIcon size={30} />}</span>
                <span data-testid="player-time" className={seek ? "font-semibold text-accent" : ""}>
                  {formatClock(pos)}
                </span>
                {chapterText && (
                  <span data-testid="player-chapter" className={`ml-6 max-w-[900px] truncate text-2xl ${seek ? "text-accent" : "text-muted"}`}>
                    {chapterText}
                  </span>
                )}
              </span>
              <span className="text-muted">{dur ? `-${formatClock(Math.max(0, dur - pos))}` : ""}</span>
            </div>
            <div className="relative mt-6 h-3 rounded-full bg-text/25">
              {stripe !== null && <div data-testid="player-buffer-stripe" className="absolute left-0 top-0 h-full rounded-full bg-text/35" style={{ width: `${stripe}%` }} />}
              <div className="absolute left-0 top-0 h-full rounded-full bg-text/50" style={{ width: `${playedPct}%` }} />
              <div className="absolute left-0 top-0 h-full rounded-full bg-accent" style={{ width: `${seek ? Math.min(pct, playedPct) : playedPct}%` }} />
              {ticks.map((p) => (
                <div key={p} data-testid="player-chapter-tick" className="absolute top-0 h-full bg-black/70" style={{ left: `${p}%`, width: 4, marginLeft: -2 }} />
              ))}
              <div
                className={`absolute top-1/2 rounded-full ${seek ? "bg-accent" : "bg-text"}`}
                style={{ left: `${pct}%`, width: seek ? 34 : 26, height: seek ? 34 : 26, marginLeft: seek ? -17 : -13, marginTop: seek ? -17 : -13 }}
              />
              {seek && (
                <div className="absolute rounded-xl bg-accent px-4 py-1 text-2xl font-semibold text-on-accent" style={{ left: `${pct}%`, bottom: 34, transform: "translateX(-50%)" }}>
                  {seek.target >= player.position() ? "+" : "−"}
                  {formatClock(Math.abs(seek.target - player.position()))}
                </div>
              )}
            </div>
            <p className="mt-6 flex justify-between text-2xl text-muted">
              <span>
                {t("player.tv.controls_hint")}
                {ticks.length > 0 && ` · ${t("chapters.hint")}`}
                {sleep.label && (
                  <span data-testid="player-sleep-left" className="ml-6 rounded-full bg-text/10 px-4 py-1 tabular-nums">
                    ☾ {sleep.label}
                  </span>
                )}
              </span>
              {ahead !== null && (
                <span data-testid="player-buffer" className="tabular-nums">
                  {bufferLabel(t, locale, ahead, flow.source)}
                </span>
              )}
            </p>
          </div>
        </div>
      )}

      {ahead !== null && player.started && !(controlsShown || seek) && panel === null && countdown === null && flow.phase === "playing" && (
        <div data-testid="player-buffer-chip" className="absolute bottom-10 right-12 rounded-full bg-black/60 px-5 py-1.5 text-2xl tabular-nums text-white/80">
          {bufferLabel(t, locale, ahead, flow.source)}
        </div>
      )}

      {playing && player.started && panel === null && countdown === null && skip.undo && (
        <div data-testid="skip-undo" className="absolute bottom-[300px] right-24 rounded-2xl bg-surface-2 px-10 py-5 text-3xl shadow-2xl">
          {t(`skip.skipped.${skip.undo.kind}`)} · <span className="font-semibold text-accent">{t("skip.tv.undo")}</span>
        </div>
      )}
      {playing && player.started && panel === null && countdown === null && !skip.undo && skipKind && (
        <div data-testid="skip-opening" data-kind={skipKind} className="absolute bottom-[300px] right-24 rounded-2xl bg-text px-10 py-5 text-3xl font-semibold text-bg shadow-2xl">
          {skipKind === "opening" && anime ? t("sources.tv.skip_opening") : t(`skip.tv.${skipKind}`)}
        </div>
      )}

      {panel !== null && flow.phase === "playing" && (
        // The Down panel hides the controls: keep what is playing and how it loads on top.
        <div data-testid="player-panel-top" className="absolute left-0 right-0 top-0">
          <div className="tv-scrim-top absolute left-0 right-0 top-0 h-[260px]" />
          <div className="absolute left-24 right-24 top-16">
            <h1 className="truncate text-5xl font-bold">{ctx.title}</h1>
            <StatsLine source={flow.source} release={flow.release} active />
            <NetStatsPanel source={flow.source} />
          </div>
        </div>
      )}
      {panel !== null && tracks && <TracksPanel items={items} index={panel} tracks={tracks} quality={qualities?.current ?? null} sleep={sleep.state} />}

      {countdown !== null && <NextCountdown n={countdown} />}

      <SleepOverlay timer={sleep} />

      {note && <div className="absolute bottom-16 left-1/2 -translate-x-1/2 rounded-3xl bg-surface-2 px-10 py-5 text-3xl shadow-2xl">{note}</div>}
    </div>
  );
}

function TracksPanel({
  items,
  index,
  tracks,
  quality,
  sleep,
}: {
  items: PanelItem[];
  index: number;
  tracks: ReturnType<typeof player.tracks>;
  quality: number | null;
  sleep: SleepState;
}) {
  const { t } = useI18n();
  const ROW = 76;
  const scroll = Math.max(0, (index - 7) * ROW);
  return (
    <div data-testid="player-tracks" className="absolute bottom-0 right-0 top-0 w-[720px] overflow-hidden bg-bg/95 px-12 pt-16 shadow-2xl">
      <div className="tv-track" style={{ transform: `translate3d(0,${-scroll}px,0)` }}>
        {items.map((it, i) => {
          const header = i === 0 || items[i - 1]!.group !== it.group;
          const can = it.group === "audio" ? tracks.canAudio : it.group === "quality" || it.group === "compat" || it.group === "episode" || it.group === "sleep" ? true : tracks.canSubtitles;
          const selected =
            it.group === "episode"
              ? false
              : it.group === "sleep"
              ? sleepChoiceOf(sleep, (it.id === "off" || it.id === "episode" ? it.id : Number(it.id)) as SleepChoice)
              : it.group === "audio"
              ? tracks.audioId === it.id
              : it.group === "quality"
                ? String(quality) === it.id
                : it.group === "compat"
                  ? player.compatState().pref === it.id
                  : tracks.subtitleId === it.id;
          return (
            <div key={`${it.group}-${it.id ?? "off"}`}>
              {header && (
                <div className={i === 0 ? "" : "mt-10"}>
                  <p className="text-3xl font-bold">
                    {it.group === "episode"
                      ? t("player.episodes")
                      : it.group === "sleep"
                      ? t("sleep.title")
                      : it.group === "audio"
                      ? t("player.audio")
                      : it.group === "quality"
                        ? t("sources.player.quality")
                        : it.group === "compat"
                          ? t("tvplay.compat.setting")
                          : t("player.subtitles")}
                  </p>
                  {!can && <p className="mt-1 text-xl text-muted">{t("player.tv.tracks_unsupported")}</p>}
                  {it.group === "audio" && tracks.audio.length === 0 && <p className="mt-3 text-2xl text-muted">{t("player.tv.no_tracks")}</p>}
                </div>
              )}
              <div
                className={`mt-3 flex items-center rounded-2xl px-6 text-3xl ${i === index ? "bg-text text-bg" : can ? "text-text" : "text-text/60"}`}
                style={{ height: ROW - 12 }}
              >
                <span className="w-12 shrink-0">{selected ? "✓" : ""}</span>
                <span className="truncate">{it.label}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NextCountdown({ n }: { n: number }) {
  const { t } = useI18n();
  const next = player.nextRef();
  return (
    <div data-testid="player-next" className="absolute bottom-20 right-20 w-[720px] rounded-3xl bg-surface-2/95 p-10 shadow-2xl">
      <p className="text-3xl text-muted">{n === MANUAL ? t("tv.watch.play_next") : t("player.tv.next_in", { n })}</p>
      {next && <p className="mt-3 truncate text-4xl font-semibold">{episodeLabel(next.season, next.episode, next.name)}</p>}
      <div className="mt-8 flex items-center text-2xl">
        <span className="rounded-xl bg-accent px-6 py-3 font-semibold text-on-accent">OK · {t("player.tv.play_now")}</span>
        <span className="ml-6 text-muted">{t("common.cancel")}: Back</span>
      </div>
      {n !== MANUAL && (
        <div className="mt-6 h-2 rounded-full bg-text/20">
          <div className="h-full rounded-full bg-accent" style={{ width: `${(n / COUNTDOWN) * 100}%`, transition: "width 1s linear" }} />
        </div>
      )}
    </div>
  );
}

function PlayIcon({ size }: { size: number }) {
  if (useConstructivism()) return <CvIcon glyph="play" width={size} height={size} />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" />
    </svg>
  );
}

function PauseIcon({ size }: { size: number }) {
  if (useConstructivism()) return <CvIcon glyph="pause" width={size} height={size} />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <rect x="5.5" y="4" width="4.5" height="16" rx="1" />
      <rect x="14" y="4" width="4.5" height="16" rx="1" />
    </svg>
  );
}

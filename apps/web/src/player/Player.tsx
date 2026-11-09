// The in-browser player: <video playsinline> with custom controls, keyboard
// and touch gestures, stream-URL refresh on expiry, progress reporting and
// the "next episode" countdown. The page (WatchPage) owns preparation, the
// first-load screen, the resume prompt and the fallback screen.
import { slowHintPref } from "./slowHint";
import { RebufferTorrentLine, SlowTorrentBanner, useLiveTorrent, useSlowSource } from "./torrentLive";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { unwrap, type MediaInfo, type PlaybackSource } from "@martytv/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { recordSessionThroughput } from "../devprefs/queries";
import { sessionThroughput } from "../devprefs/logic";
import { api } from "../api";
import { formatSpeed } from "../play/releases";
import { releaseSummary } from "../play/PlayOnTv";
import { autoSkipDue, chapterIndexAt, chapterTicks, fileChapters, hasMediaSource, hlsMode, isAndroid, isHlsSource, markerKey, skipTarget, type Chapter, type HlsMode, type SkipMode } from "@martytv/media-types";
import { Spinner, useI18n } from "@martytv/ui";
import {
  AudioTrackIcon,
  CheckIcon,
  ChevronLeft,
  DownloadIcon,
  ExitFullscreenIcon,
  FullscreenIcon,
  MuteIcon,
  NextIcon,
  PauseIcon,
  PipIcon,
  PlayIcon,
  SkipIcon,
  SpeedIcon,
  SubtitlesIcon,
  VolumeIcon,
} from "../icons";
import { formatClock } from "../watch/format";
import { trackLabel } from "../play/releases";
import {
  bandwidthCheck,
  bufferedAhead,
  bufferedSegments,
  classifyTap,
  estimateRate,
  mbit,
  REBUFFER_AFTER_SEEK,
  rebufferDone,
  rebufferPercent,
  rebufferTarget,
  sourceBitrate,
  type RateSample,
  type ResumeReason,
  clampVolume,
  CONTROLS_INIT,
  controlsReducer,
  keyCommand,
  lateResume,
  mediaErrorKind,
  NEXT_COUNTDOWN,
  qualityReload,
  reloadUrl,
  SEEK_BACK,
  SEEK_FORWARD,
  seekBy,
  silentPlayback,
  SPEEDS,
  tapZone,
  type ErrorKind,
  type Menu,
  type Tap,
} from "./logic";
import {
  audioProbe,
  audioTracks,
  bufferedRanges,
  canFullscreen,
  canPip,
  enterFullscreen,
  exitFullscreen,
  fullscreenElement,
  lockLandscape,
  seekableRanges,
  streamStatus,
  togglePip,
  unlockOrientation,
} from "./media";
import { ProgressReporter, type SessionStart, type Snapshot } from "./reporter";
import { sessionTransport } from "./session";
import { attachHls, type HlsHandle } from "./hls";
import { setSourceQuality } from "../play/sourcesApi";
import { downloadBadge, PlayerDownloadMenu } from "../downloads/PlayerDownloadMenu";
import {
  compatFormat,
  compatSeek,
  compatSrc,
  compatStatus,
  expectsAudio,
  fetchStreamStart,
  fileDuration,
  HLS_RESUME_RELOAD_MS,
  hlsLocalRanges,
  pickCompatAudio,
  subsSrc,
  textSubtitles,
  type CompatFormat,
} from "./compat";
import { thisBrowser } from "../play/browserSupport";
import { audioPosition, chooseAudio, defaultAudioIndex, readAudioChoice, writeAudioChoice } from "./audioChoice";

type MediaStream = MediaInfo["audio"][number];

/**
 * Engines with `audioTracks` (Safari): enable the preferred / remembered
 * track of the original stream. The element lists the file's audio streams
 * in ffprobe's order; a count mismatch means the mapping is unknown.
 */
function pickNativeAudio(v: HTMLVideoElement, info: MediaInfo | null | undefined, prefs: PlayerProps["audioPrefs"], key: string | null | undefined) {
  const list = audioTracks(v);
  if (!list || !info || list.length < 2 || list.length !== info.audio.length) return;
  const choice = chooseAudio(info, prefs ?? {}, readAudioChoice(key));
  if (!choice || choice.reason === "default") return;
  const pos = audioPosition(info, choice.index);
  if (pos < 0 || list[pos]!.enabled) return;
  for (let j = 0; j < list.length; j++) list[j]!.enabled = j === pos;
}

export interface NextUpInfo {
  code: string;
  name: string | null;
  go: () => void;
}

export interface PlayerProps {
  source: PlaybackSource;
  title: string;
  subtitle: string | null;
  /** Poster for «Скачать на устройство». */
  poster?: string | null;
  /** null: hold (resume prompt open / still deciding); else start here. */
  startAt: number | null;
  /** The start was decided from known progress (else the session's resume point applies). */
  decided: boolean;
  /** Loader still covering the video. */
  covered: boolean;
  /** An overlay needs attention: keep the video paused. */
  hold?: boolean;
  session: { profile_id: string; media_id: string; episode_id?: string | null } | null;
  /** GET /playback/sources/{id}: a fresh stream URL. */
  refresh: () => Promise<PlaybackSource | null>;
  /** The source changed here (online quality switch): update the page's copy. */
  onSourceChange?: (s: PlaybackSource) => void;
  onMetadata: () => void;
  onFirstFrame: () => void;
  onFatal: (kind: ErrorKind, position: number) => void;
  onSilent: (position: number) => void;
  onEnded: () => void;
  onStale: () => void;
  onBack: () => void;
  /** Position updates for the page (fallback actions resume from here). */
  positionRef: { current: number };
  next: NextUpInfo | null;
  /** Series: the previous episode (⏮ in the controls), when there is one. */
  prev?: NextUpInfo | null;
  autoplayNext: boolean;
  /** «Отсчёт перед следующим» (default on); off: the next episode starts at once. */
  autoplayCountdown?: boolean;
  /** «Заставки и титры» (profile skip_segments): button (default), auto, off. */
  skipMode?: SkipMode;
  /** Overlays from the page (no-sound banner, stale notice). */
  children?: ReactNode;
  /** Play the compat stream (source.compat_url: audio → AAC, MP4) instead of stream_url. */
  compat?: boolean;
  /** The user toggled «Совместимый режим» in the audio menu. */
  onCompatToggle?: (on: boolean) => void;
  /** Profile preferences for the compat audio track (voice-over studios, languages). */
  audioPrefs?: { voiceovers?: readonly string[] | null; languages?: readonly string[] | null };
  /** Per-title memory of the picked audio track (the media id). */
  audioKey?: string | null;
  /** A track the original stream can't switch to was picked: play through compat (no «always» preference). */
  onCompatAudio?: () => void;
  /** TMDB runtime: the compat timeline's length until ffprobe reports the file's. */
  runtimeSeconds?: number | null;
  /** «Выбрать раздачу полегче»: the connection is slower than this release needs. */
  onLighter?: (rateBps: number) => void;
}

/** A rebuffer in progress (the player paused itself after a stall). */
interface Rebuffer {
  since: number;
  target: number;
  canPlayThrough: boolean;
  /** Highest percentage shown (never goes back). */
  shown?: number;
  /** Buffered end (element time) and when it last grew. */
  end?: number;
  grewAt?: number;
}

/** Compat stream state: the audio track and where the current load starts (absolute seconds). */
interface CompatLoad {
  audio: number | null;
  start: number;
  /** The stream URL for this load is set (its keyframe offset is known). */
  ready?: boolean;
}

interface VState {
  paused: boolean;
  time: number;
  duration: number;
  buffered: [number, number][];
  volume: number;
  muted: boolean;
  rate: number;
  waiting: boolean;
  ended: boolean;
}

const V0: VState = { paused: true, time: 0, duration: 0, buffered: [], volume: 1, muted: false, rate: 1, waiting: false, ended: false };

function readState(v: HTMLVideoElement, waiting: boolean): VState {
  return {
    paused: v.paused,
    time: v.currentTime,
    duration: Number.isFinite(v.duration) ? v.duration : 0,
    buffered: bufferedRanges(v),
    volume: v.volume,
    muted: v.muted,
    rate: v.playbackRate,
    waiting,
    ended: v.ended,
  };
}

const VOLUME_KEY = "martytv.volume";
function readVolume(): { volume: number; muted: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(VOLUME_KEY) ?? "null") as { volume?: number; muted?: boolean } | null;
    return { volume: clampVolume(raw?.volume ?? 1), muted: !!raw?.muted };
  } catch {
    return { volume: 1, muted: false };
  }
}

/** iOS/iPadOS ignore `volume` on media elements (hardware buttons only), so a slider there does nothing. */
const VOLUME_SETTABLE = (() => {
  try {
    const probe = document.createElement("video");
    probe.volume = 0.5;
    return probe.volume === 0.5;
  } catch {
    return true;
  }
})();

function restoreVolume(v: HTMLVideoElement) {
  const saved = readVolume();
  v.volume = saved.volume;
  v.muted = saved.muted;
}

/**
 * While paused: what plays and how it loads — «1080p · Дубляж · 14,6 ГБ ·
 * Пиров 23 · сидов 9 · Скорость: 3,2 МБ/с», refreshed every 2 s (the page's
 * source query stops polling once the source is ready).
 */
function PausedStats({ source }: { source: PlaybackSource }) {
  const { t, locale } = useI18n();
  const torrentSource = source.kind !== "online";
  const live = useQuery({
    queryKey: ["source-live", source.id],
    queryFn: () => unwrap(api.GET("/playback/sources/{id}", { params: { path: { id: source.id } } })),
    enabled: torrentSource,
    refetchInterval: 2000,
    staleTime: 1000,
    retry: false,
  });
  const tor = (torrentSource && (live.data?.torrent ?? source.torrent)) || null;
  const quality =
    source.kind === "online"
      ? [source.quality ? `${source.quality}p` : null, source.release.title, source.provider?.name].filter(Boolean).join(" · ")
      : releaseSummary(source.release, locale);
  const parts = [
    quality || null,
    tor ? t("player.tv.peers", { peers: tor.peers, seeders: tor.seeders }) : null,
    tor ? t("player.tv.speed", { speed: formatSpeed(tor.download_speed_bps, locale) }) : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <p className="mt-0.5 truncate text-xs tabular-nums text-white/70 drop-shadow sm:text-sm" data-testid="player-paused-stats">
      {parts.join(" · ")}
    </p>
  );
}

/** While rebuffering: the torrent downloads slower than the release plays → «Другая раздача» / «Подождать». */
function RebufferSlowHint({ source, onLighter }: { source: PlaybackSource; onLighter?: (rateBps: number) => void }) {
  const tor = useLiveTorrent(source, true);
  const { slow, wait } = useSlowSource(source, tor, true, source.id);
  if (!slow) return null;
  return (
    <div className="absolute inset-x-0 bottom-[calc(max(env(safe-area-inset-bottom),0.5rem)+5.5rem)] z-20 flex justify-center px-3">
      <SlowTorrentBanner slow={slow} onWait={wait} onAnother={onLighter ? () => onLighter(slow.speedBps * 8) : undefined} />
    </div>
  );
}

export function Player(props: PlayerProps) {
  const { t, locale } = useI18n();
  const { source } = props;
  const root = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  // The element as state too, so render can read its capabilities.
  const [el, setEl] = useState<HTMLVideoElement | null>(null);
  const bindVideo = useCallback((n: HTMLVideoElement | null) => {
    video.current = n;
    setEl(n);
  }, []);
  const [shown, setShown] = useState(false);
  // Compat mode loads its first URL once the start is known (see below).
  const [src, setSrc] = useState(() => (props.compat && source.compat_url ? "" : (source.stream_url ?? "")));
  const [vs, setVs] = useState<VState>(V0);
  const [controls, dispatch] = useReducer(controlsReducer, CONTROLS_INIT);
  const [scrub, setScrub] = useState<number | null>(null);
  const [fs, setFs] = useState(false);
  const [ripple, setRipple] = useState<{ side: "left" | "right"; amount: number; key: number } | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [tracksTick, setTracksTick] = useState(0);
  const waiting = useRef(false);
  const started = useRef(false);
  const firstFrame = useRef(false);
  const reload = useRef<{ at: number; play: boolean } | null>(null);
  const refreshes = useRef(0);
  const lastTap = useRef<Tap | null>(null);
  const singleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snap = useRef<Snapshot | null>(null);
  const silentChecked = useRef(false);
  // Compat stream flavour: HLS for Safari / iOS (no progressive MP4 without ranges), else MP4.
  const [compatFmt] = useState<CompatFormat>(() => {
    const { probe, env } = thisBrowser();
    return compatFormat(env, probe);
  });
  /** When the user paused (HLS compat: a long pause outlives the server's session). */
  const pausedAt = useRef<number | null>(null);
  // Online HLS: the engine's own HLS (not on Android: hls.js seeks reliably there), else hls.js (lazy), else unplayable.
  const [mode] = useState<HlsMode>(() =>
    isHlsSource(source) ? hlsMode(typeof document !== "undefined" ? document.createElement("video") : null, hasMediaSource(), isAndroid()) : "native",
  );
  const [quality, setQuality] = useState<number | null>(source.quality ?? null);
  const [toast, setToast] = useState<string | null>(null);
  const hlsFatal = useRef<(kind: ErrorKind) => void>(() => undefined);
  // Compat: the element's 0 is `off.current` seconds into the file.
  const off = useRef(0);
  const cmpRef = useRef<CompatLoad | null>(null);
  /** Absolute target of a compat restart until its stream is in the element (see absTime). */
  const cmpWait = useRef<number | null>(null);
  const [cmp, setCmp] = useState<CompatLoad | null>(null);
  const [cmpSub, setCmpSub] = useState<{ index: number; burst: number } | null>(null);
  /** A track picked in the menu while the original stream plays: compat starts with it. */
  const audioWant = useRef<number | null>(null);
  const seekAbs = useRef<(abs: number) => void>(() => undefined);
  // Rebuffering to a threshold (logic.ts "rebuffering") and bandwidth.
  const rebuf = useRef<Rebuffer | null>(null);
  const [rebufView, setRebufView] = useState<{ pct: number; ahead: number; rate: number | null } | null>(null);
  const [lastResume, setLastResume] = useState<ResumeReason | "user" | null>(null);
  const lastStall = useRef<number | null>(null);
  const stalls = useRef<number[]>([]);
  const seekedAt = useRef(0);
  const rateSamples = useRef<RateSample[]>([]);
  const sessionRates = useRef<number[]>([]);
  const qc = useQueryClient();
  useEffect(
    () => () => {
      // End of the session: store its median and re-report this browser's profile.
      recordSessionThroughput(qc, sessionThroughput(sessionRates.current));
    },
    [qc],
  );
  const lowSince = useRef<number | null>(null);
  const [bwHint, setBwHint] = useState<{ rate: number; bitrate: number } | null>(null);
  const hintDismissed = useRef(false);
  const compatOn = !!props.compat && !!source.compat_url && mode === "native";
  /**
   * Absolute position (compat: offset + element time). While a compat
   * restart is on its way, the target: the old stream keeps playing until
   * the new one is set, and its time used to overwrite the position — the
   * bar jumped back, progress reports and ±10/30 s counted from the old spot.
   */
  const absTime = (v: HTMLVideoElement) => cmpWait.current ?? v.currentTime + (cmpRef.current ? off.current : 0);

  // Latest props for event handlers registered once.
  const P = useRef(props);
  useLayoutEffect(() => {
    P.current = props;
  });

  const sync = useCallback(() => {
    const v = video.current;
    if (!v) return;
    const s = readState(v, waiting.current);
    if (cmpRef.current) {
      const o = off.current;
      s.time += o;
      s.buffered = s.buffered.map(([a, b]) => [a + o, b + o]);
      s.duration = fileDuration(P.current.source, P.current.runtimeSeconds) ?? 0;
      if (cmpWait.current !== null) s.time = cmpWait.current;
    }
    setVs(s);
  }, []);

  // ------------------------------------------------------------ reporter

  const [reporter] = useState(() => {
    const r = new ProgressReporter(sessionTransport);
    r.onStale = () => P.current.onStale();
    return r;
  });
  const probe = useCallback((): Snapshot | null => {
    const v = video.current;
    if (!v) return snap.current;
    const d =
      Number.isFinite(v.duration) && v.duration > 0 && !cmpRef.current
        ? v.duration
        : (P.current.source.media_info?.duration_seconds ?? P.current.source.duration_seconds ?? null);
    // Compat: the element counts from the stream's start; report file time.
    // Rebuffering counts as playing (the player paused itself, not the user).
    return { position: absTime(v), duration: d, paused: v.paused && !rebuf.current };
  }, []);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") reporter.hidden();
    };
    const onPageHide = () => reporter.hidden();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      // Leaving the player: a final "stopped" report from the last known position.
      reporter.end(snap.current);
    };
  }, [reporter]);

  const beginSession = useCallback(() => {
    const s = P.current.session;
    if (!s || reporter.active) return;
    void reporter
      .begin({ ...s, source_id: P.current.source.id }, probe)
      .then((r: SessionStart | null) => {
        const v = video.current;
        const at = v ? lateResume(P.current.decided, r?.resume_position_seconds, absTime(v)) : null;
        if (v && at != null) seekAbs.current(at);
      });
  }, [reporter, probe]);

  // ------------------------------------------------------------ start / reload

  const tryPlay = useCallback(() => {
    const v = video.current;
    if (!v) return;
    v.play().catch((e: unknown) => {
      // Autoplay blocked (no user gesture after preparing): show the big play button.
      if ((e as { name?: string })?.name === "NotAllowedError") {
        if (!firstFrame.current) {
          firstFrame.current = true;
          setShown(true);
          P.current.onFirstFrame();
        }
        sync();
      }
    });
  }, [sync]);

  const maybeStart = useCallback(() => {
    const v = video.current;
    const at = P.current.startAt;
    if (!v || started.current || at == null || v.readyState < 1) return;
    started.current = true;
    const d = Number.isFinite(v.duration) ? v.duration : Infinity;
    // Compat streams already start there (start= in the URL).
    if (at > 0 && !cmpRef.current) v.currentTime = Math.min(at, Math.max(0, d - 3));
    tryPlay();
  }, [tryPlay]);

  useEffect(() => {
    maybeStart();
  }, [props.startAt, maybeStart]);

  // ------------------------------------------------------------ compat stream

  /**
   * (Re)load the compat stream at absolute `at` with `audio`: ask where it
   * will really start (keyframe), then point the element there. play null =
   * the first load (maybeStart starts playback); else continue playing or not.
   */
  const loadCompat = useCallback(async (at: number, audio: number | null, play: boolean | null, url?: string) => {
    const base = url ?? P.current.source.compat_url;
    if (!base) return;
    const want = Math.max(0, at);
    const load: CompatLoad = { audio, start: want };
    cmpRef.current = load;
    cmpWait.current = want;
    seekedAt.current = Date.now();
    rateSamples.current = [];
    const k = await fetchStreamStart(compatSrc(base, { audio, start: want, format: compatFmt }), want);
    if (cmpRef.current !== load) return; // superseded by a newer seek / switch
    load.start = k;
    load.ready = true;
    off.current = k;
    reload.current = play == null ? null : { at: 0, play };
    setCmp({ ...load });
    setCmpSub((cur) => (cur ? { index: cur.index, burst: 60 } : cur));
    setSrc((cur) => {
      const next = compatSrc(base, { audio, start: k, format: compatFmt });
      return next === cur ? `${next}${next.includes("?") ? "&" : "?"}r=${Date.now()}` : next;
    });
  }, [compatFmt]);

  // The restarted compat stream is in the element (its time counts from the new offset).
  useEffect(() => {
    if (cmpRef.current?.ready) cmpWait.current = null;
  }, [src]);

  // ------------------------------------------------------------ rebuffering / bandwidth

  const endRebuffer = useRef<(reason: ResumeReason | "user", play: boolean) => void>(() => undefined);
  useLayoutEffect(() => {
    endRebuffer.current = (reason, play) => {
      const r = rebuf.current;
      if (!r) return;
      lastStall.current = (Date.now() - r.since) / 1000;
      rebuf.current = null;
      setRebufView(null);
      setLastResume(reason);
      if (play) tryPlay();
    };
  }, [tryPlay]);

  useEffect(() => {
    const id = setInterval(() => {
      const v = video.current;
      if (!v || !v.currentSrc) return;
      const s = P.current.source;
      const now = Date.now();
      const ahead = bufferedAhead(bufferedRanges(v), v.currentTime);
      const duration = s.media_info?.duration_seconds ?? s.duration_seconds ?? null;
      const bitrate = sourceBitrate(s.file?.size_bytes, duration);
      // Buffer growth only measures the connection while the browser is
      // still fetching (it stops well before a minute ahead).
      if (ahead < 50) rateSamples.current = [...rateSamples.current.filter((x) => x.at > now - 30_000), { at: now, end: v.currentTime + ahead }];
      else rateSamples.current = [];
      const rate = estimateRate(rateSamples.current, bitrate, now);
      // This session's throughput sample (the device profile's auto.throughput_bps):
      // only the direct file while it is fetching (the compat stream's bitrate differs).
      if (rate != null && ahead < 50 && !cmpRef.current && sessionRates.current.length < 2000) sessionRates.current.push(rate);
      if (started.current && firstFrame.current) {
        const bw = bandwidthCheck({ rate, bitrate, lowSince: lowSince.current, stalls: stalls.current, now });
        lowSince.current = bw.lowSince;
        if (bw.hint && bitrate && !hintDismissed.current && P.current.onLighter && slowHintPref.get()) {
          hintDismissed.current = true; // once per player
          setBwHint({ rate: rate ?? bitrate, bitrate });
        }
      }
      const r = rebuf.current;
      if (!r) return;
      // A paused browser that stopped fetching below the target plays what it has.
      const end = v.currentTime + ahead;
      if (r.end === undefined || end > r.end + 0.1) {
        r.end = end;
        r.grewAt = now;
      }
      const done = rebufferDone({ ahead, target: r.target, canPlayThrough: r.canPlayThrough, time: absTime(v), duration, stuckMs: now - (r.grewAt ?? now) });
      if (done) endRebuffer.current(done, true);
      else {
        // Never back: the buffered end may shrink a little between ticks.
        r.shown = Math.max(r.shown ?? 0, rebufferPercent(ahead, r.target));
        setRebufView({ pct: r.shown, ahead, rate });
      }
    }, 500);
    return () => clearInterval(id);
  }, []);

  // Enter / leave compat mode (page decision or the menu toggle).
  useEffect(() => {
    const v = video.current;
    if (!compatOn) {
      if (!cmpRef.current) return;
      const abs = P.current.positionRef.current;
      cmpRef.current = null;
      cmpWait.current = null;
      off.current = 0;
      setCmp(null);
      setCmpSub(null);
      reload.current = started.current ? { at: abs, play: !!v && !v.paused && !v.ended } : null;
      setSrc(P.current.source.stream_url ?? "");
      return;
    }
    if (cmpRef.current) return;
    const at = started.current ? P.current.positionRef.current : P.current.startAt;
    if (at == null) return; // resume prompt still open: load once decided
    const want = audioWant.current;
    audioWant.current = null;
    const audio = want ?? pickCompatAudio(P.current.source.media_info, P.current.audioPrefs ?? {}, readAudioChoice(P.current.audioKey));
    if (started.current) setToast(t("player.web.compat.on"));
    void loadCompat(at, audio, started.current ? !!v && !v.paused && !v.ended : null);
  }, [compatOn, props.startAt, loadCompat, t]);

  // ffprobe info arrived while compat plays the server's default track
  // (fresh torrent): the menu marks that one, and a preferred voice that
  // isn't it is switched to.
  const info0 = source.media_info;
  useEffect(() => {
    const c = cmpRef.current;
    const v = video.current;
    if (!c || c.audio != null || !info0 || !info0.audio.length) return;
    const def = defaultAudioIndex(info0);
    const choice = chooseAudio(info0, P.current.audioPrefs ?? {}, readAudioChoice(P.current.audioKey));
    if (choice && choice.reason !== "default" && choice.index !== def && v) {
      void loadCompat(P.current.positionRef.current, choice.index, started.current ? !v.paused && !v.ended : null);
    } else {
      c.audio = def;
      setCmp((cur) => (cur ? { ...cur, audio: def } : cur));
    }
  }, [info0, loadCompat]);

  const held = useRef(false);
  useEffect(() => {
    if (props.hold) {
      held.current = true;
      video.current?.pause();
    } else if (held.current) {
      // Back from the overlay ("Keep watching"): continue where it was.
      held.current = false;
      if (started.current) tryPlay();
    }
  }, [props.hold, tryPlay]);

  // ------------------------------------------------------------ video events

  useEffect(() => {
    // `el` (state) re-runs this once the element mounts; the ref is what's mutated.
    const v = el ? video.current : null;
    if (!v) return;
    restoreVolume(v);
    let silentTimer: ReturnType<typeof setTimeout> | null = null;

    const on: Record<string, () => void> = {
      loadedmetadata: () => {
        P.current.onMetadata();
        if (!cmpRef.current) pickNativeAudio(v, P.current.source.media_info, P.current.audioPrefs, P.current.audioKey);
        const r = reload.current;
        if (r) {
          reload.current = null;
          if (r.at > 0) v.currentTime = r.at;
          if (r.play) tryPlay();
        } else maybeStart();
        sync();
      },
      playing: () => {
        waiting.current = false;
        if (!firstFrame.current) {
          firstFrame.current = true;
          setShown(true);
          P.current.onFirstFrame();
        }
        beginSession();
        reporter.report("playing");
        if (!silentChecked.current && !cmpRef.current) {
          silentChecked.current = true;
          silentTimer = setTimeout(() => {
            if (v.paused || v.currentTime < 1) {
              silentChecked.current = false;
              return;
            }
            // No ffprobe info yet (fresh torrent): assume there is sound to miss.
            if (expectsAudio(P.current.source) && !cmpRef.current && silentPlayback(audioProbe(v)) === true) P.current.onSilent(absTime(v));
          }, 4000);
        }
        setCountdown(null);
        sync();
      },
      pause: () => {
        if (rebuf.current) {
          sync(); // our own pause while rebuffering: not reported
          return;
        }
        if (!v.ended && started.current) reporter.report("paused");
        pausedAt.current = Date.now();
        dispatch({ type: "activity", now: Date.now() });
        sync();
      },
      seeked: () => {
        if (started.current && firstFrame.current) reporter.seeked();
        sync();
      },
      waiting: () => {
        waiting.current = true;
        // A stall after playback started: pause and rebuffer to a threshold
        // instead of resuming on every sliver of data.
        if (started.current && firstFrame.current && !v.paused && !v.ended && !rebuf.current) {
          const now = Date.now();
          const afterSeek = now - seekedAt.current < 4000;
          if (!afterSeek) stalls.current = [...stalls.current.filter((x) => x > now - 120_000), now];
          rebuf.current = { since: now, target: rebufferTarget(lastStall.current, afterSeek), canPlayThrough: false };
          setRebufView({ pct: 0, ahead: 0, rate: null });
          v.pause();
        }
        sync();
      },
      canplaythrough: () => {
        if (rebuf.current) rebuf.current.canPlayThrough = true;
      },
      canplay: () => {
        waiting.current = false;
        sync();
      },
      ended: () => {
        reporter.report("ended");
        P.current.onEnded();
        dispatch({ type: "activity", now: Date.now() });
        if (P.current.next) {
          if (P.current.autoplayNext && P.current.autoplayCountdown === false) P.current.next.go();
          else setCountdown(P.current.autoplayNext ? NEXT_COUNTDOWN : -1);
        }
        sync();
      },
      timeupdate: () => {
        const abs = absTime(v);
        P.current.positionRef.current = abs;
        const dur = cmpRef.current ? (P.current.source.media_info?.duration_seconds ?? null) : Number.isFinite(v.duration) ? v.duration : null;
        snap.current = { position: abs, duration: dur, paused: v.paused };
        sync();
      },
      progress: sync,
      durationchange: sync,
      volumechange: () => {
        try {
          localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume: v.volume, muted: v.muted }));
        } catch {
          // private mode
        }
        sync();
      },
      ratechange: sync,
      play: () => {
        // Play pressed while rebuffering: the user resumes early.
        if (rebuf.current) endRebuffer.current("user", false);
        // HLS compat after a long pause: the server dropped the session;
        // restart it here rather than wait for a failing segment.
        const c = cmpRef.current;
        const since = pausedAt.current;
        pausedAt.current = null;
        if (c && compatFmt === "hls" && since != null && Date.now() - since > HLS_RESUME_RELOAD_MS) {
          void loadCompat(absTime(v), c.audio, true);
        }
        sync();
      },
      error: () => void onError(),
    };

    const onError = () => handleError(mediaErrorKind(v.error?.code));
    hlsFatal.current = (kind) => void handleError(kind);
    const handleError = async (kind: ErrorKind) => {
      if (kind === "aborted") return;
      const pos = P.current.positionRef.current;
      const wasPlaying = started.current && firstFrame.current;
      if (cmpRef.current) {
        // Compat: a busy transcoder can't be fixed by retrying; an expired
        // token or a dropped connection restarts at the current position.
        const status = await compatStatus(v.currentSrc || src, fetch, compatFmt === "hls" ? "HEAD" : "GET");
        if (status === 503) {
          setToast(t("player.web.compat.busy"));
        } else if (refreshes.current < 2) {
          refreshes.current++;
          const fresh = await P.current.refresh().catch(() => null);
          if (fresh?.compat_url) {
            void loadCompat(pos, cmpRef.current.audio, wasPlaying || !v.paused, fresh.compat_url);
            return;
          }
        }
        P.current.onFatal(kind, pos);
        return;
      }
      // An expired / invalid token answers 403, which engines report as an
      // unsupported source: check the URL before blaming the file.
      if (refreshes.current < 2) {
        // hls.js plays from a blob: URL; the playlist URL is what expires.
        const status = await streamStatus(mode === "hlsjs" ? src : v.currentSrc || src);
        if (status === 403 || status === 0 || (kind === "network" && status < 400)) {
          refreshes.current++;
          const fresh = await P.current.refresh().catch(() => null);
          if (fresh?.stream_url) {
            reload.current = { at: pos, play: wasPlaying || !v.paused };
            setSrc(reloadUrl(fresh.stream_url, src, fresh.quality ?? 0));
            return;
          }
        }
      }
      P.current.onFatal(kind, pos);
    };

    for (const [k, fn] of Object.entries(on)) v.addEventListener(k, fn);
    // Already loaded before listeners (cached / fast): run the start logic.
    if (v.readyState >= 1) on.loadedmetadata!();
    return () => {
      for (const [k, fn] of Object.entries(on)) v.removeEventListener(k, fn);
      if (silentTimer) clearTimeout(silentTimer);
    };
    // `src` is read by onError for the HEAD check.
  }, [el, src, mode, sync, maybeStart, tryPlay, beginSession, reporter, loadCompat, t, compatFmt]);

  // hls.js: (re)attached for every stream URL (quality switch, refreshed token).
  useEffect(() => {
    if (mode !== "hlsjs" || !el || !src) return;
    let handle: HlsHandle | null = null;
    let cancelled = false;
    const startAt = reload.current?.at ?? (started.current ? P.current.positionRef.current : (P.current.startAt ?? 0));
    attachHls(el, src, (kind) => hlsFatal.current(kind === "network" ? "network" : "decode"), startAt).then(
      (h) => {
        if (cancelled) h.destroy();
        else handle = h;
      },
      () => {
        if (!cancelled) P.current.onFatal("unsupported", P.current.positionRef.current);
      },
    );
    return () => {
      cancelled = true;
      handle?.destroy();
    };
  }, [mode, el, src]);

  // Neither native HLS nor Media Source Extensions: nothing can play it here.
  useEffect(() => {
    if (mode === "none") P.current.onFatal("unsupported", P.current.positionRef.current);
  }, [mode]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(id);
  }, [toast]);

  /** Online sources: PATCH {quality} → new stream URL, same position. */
  const switchQuality = useCallback(
    async (q: number) => {
      const v = video.current;
      const plan = qualityReload(v, P.current.positionRef.current);
      try {
        const fresh = await setSourceQuality(P.current.source.id, q);
        if (fresh.status !== "ready" || !fresh.stream_url) throw new Error("not ready");
        reload.current = plan;
        setQuality(fresh.quality ?? q);
        setSrc((cur) => reloadUrl(fresh.stream_url!, cur, q));
        P.current.onSourceChange?.(fresh);
      } catch {
        setToast(t("sources.player.quality_failed"));
      }
    },
    [t],
  );

  // Audio track list changes (Safari).
  useEffect(() => {
    const list = audioTracks(el);
    if (!list?.addEventListener) return;
    const fn = () => setTracksTick((n) => n + 1);
    list.addEventListener("change", fn);
    list.addEventListener("addtrack", fn);
    return () => {
      list.removeEventListener?.("change", fn);
      list.removeEventListener?.("addtrack", fn);
    };
  }, [el, src]);

  // ------------------------------------------------------------ controls visibility

  // While rebuffering the player paused itself; the controls show "playing".
  const shownPaused = vs.paused && !rebufView;
  const playing = !shownPaused && !vs.ended;
  const busy = scrub !== null;
  useEffect(() => {
    const id = setInterval(() => dispatch({ type: "tick", now: Date.now(), playing, busy }), 500);
    return () => clearInterval(id);
  }, [playing, busy]);
  const poke = useCallback(() => dispatch({ type: "activity", now: Date.now() }), []);

  // ------------------------------------------------------------ actions

  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (rebuf.current) {
      // Rebuffering looks like playing: the button pauses for real.
      endRebuffer.current("user", false);
      reporter.report("paused");
      sync();
      poke();
      return;
    }
    if (v.paused || v.ended) {
      if (!started.current) maybeStart();
      else tryPlay();
    } else v.pause();
    poke();
  }, [maybeStart, tryPlay, poke, reporter, sync]);

  const seek = useCallback(
    (to: number) => {
      const v = video.current;
      if (!v) return;
      seekedAt.current = Date.now();
      rateSamples.current = [];
      // A seek while rebuffering only needs the smaller threshold.
      if (rebuf.current) Object.assign(rebuf.current, { target: REBUFFER_AFTER_SEEK, shown: 0, end: undefined, grewAt: Date.now() });
      const c = cmpRef.current;
      if (c) {
        // Compat: within the buffer, else restart the stream there.
        const dur = fileDuration(P.current.source, P.current.runtimeSeconds);
        // HLS: Safari seeks within the generated segments itself.
        const ranges = compatFmt === "hls" ? hlsLocalRanges(seekableRanges(v), v.currentTime) : bufferedRanges(v);
        // A restart still on its way: always restart again (the old stream's
        // buffer is about to go — a «local» seek in it was undone by the
        // pending restart landing afterwards).
        const target = seekBy(to, 0, dur ? Math.max(0, dur - 3) : null);
        const d = cmpWait.current !== null ? { kind: "reload" as const, at: target } : compatSeek(target, off.current, ranges);
        if (d.kind === "local") v.currentTime = d.at;
        else {
          P.current.positionRef.current = d.at;
          if (started.current) reporter.seeked();
          void loadCompat(d.at, c.audio, started.current ? !v.ended && (!v.paused || !firstFrame.current) : null);
        }
      } else v.currentTime = seekBy(to, 0, Number.isFinite(v.duration) ? v.duration : null);
      setCountdown(null);
      sync();
      poke();
    },
    [sync, poke, loadCompat, reporter, compatFmt],
  );
  useLayoutEffect(() => {
    seekAbs.current = seek;
  }, [seek]);

  const skip = useCallback(
    (delta: number) => {
      const v = video.current;
      if (!v) return;
      const dur = cmpRef.current ? fileDuration(P.current.source, P.current.runtimeSeconds) : Number.isFinite(v.duration) ? v.duration : null;
      seek(seekBy(absTime(v), delta, dur));
    },
    [seek],
  );

  /** Compat: another audio track = the same position with a new stream. */
  const switchCompatAudio = useCallback(
    (index: number) => {
      const v = video.current;
      if (!v) return;
      writeAudioChoice(P.current.audioKey, P.current.source.media_info?.audio.find((a) => a.index === index));
      if (!cmpRef.current) {
        // The original stream can't switch (no audioTracks): compat with that track.
        audioWant.current = index;
        P.current.onCompatAudio?.();
        return;
      }
      void loadCompat(P.current.positionRef.current, index, started.current ? !v.paused && !v.ended : null);
    },
    [loadCompat],
  );

  const setVolume = useCallback((vol: number) => {
    const v = video.current;
    if (!v) return;
    v.volume = clampVolume(vol);
    if (v.volume > 0) v.muted = false;
  }, []);

  const toggleMute = useCallback(() => {
    const v = video.current;
    if (v) v.muted = !v.muted;
    poke();
  }, [poke]);

  const toggleFullscreen = useCallback(async () => {
    const v = video.current;
    const r = root.current;
    if (!v || !r) return;
    if (fullscreenElement()) {
      await exitFullscreen();
      return;
    }
    if (await enterFullscreen(r, v)) {
      // Phones: landscape for landscape video.
      if (v.videoWidth >= v.videoHeight) lockLandscape();
    }
  }, []);

  useEffect(() => {
    const fn = () => {
      const on = !!fullscreenElement();
      setFs(on);
      if (!on) unlockOrientation();
    };
    document.addEventListener("fullscreenchange", fn);
    document.addEventListener("webkitfullscreenchange", fn);
    return () => {
      document.removeEventListener("fullscreenchange", fn);
      document.removeEventListener("webkitfullscreenchange", fn);
      if (fullscreenElement()) void exitFullscreen();
    };
  }, []);

  // Keyboard shortcuts (not while typing; Space/Enter on a focused button presses it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      if ((e.key === " " || e.key === "Enter") && (tag === "BUTTON" || tag === "A")) return;
      if (el?.getAttribute("role") === "slider" && /^Arrow/.test(e.key)) return;
      const cmd = keyCommand(e.key);
      if (!cmd) return;
      e.preventDefault();
      if (cmd.type === "toggle") togglePlay();
      else if (cmd.type === "seek") {
        skip(cmd.delta);
        setRipple({ side: cmd.delta < 0 ? "left" : "right", amount: Math.abs(cmd.delta), key: Date.now() });
      } else if (cmd.type === "volume") {
        const v = video.current;
        if (v) setVolume(v.volume + cmd.delta);
        poke();
      } else if (cmd.type === "mute") toggleMute();
      else void toggleFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, skip, setVolume, toggleMute, toggleFullscreen, poke]);

  // Touch: single tap toggles the controls, double tap on a side seeks ±10 s.
  // Mouse: click toggles play, double click toggles fullscreen.
  const onSurfaceUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse") {
      if (e.button !== 0) return;
      if (controls.menu) return dispatch({ type: "menu", menu: null, now: Date.now() });
      togglePlay();
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const tap: Tap = { t: e.timeStamp || Date.now(), zone: tapZone(e.clientX - rect.left, rect.width) };
    const kind = classifyTap(lastTap.current, tap);
    lastTap.current = tap;
    if (kind === "double") {
      if (singleTimer.current) clearTimeout(singleTimer.current);
      singleTimer.current = null;
      const delta = tap.zone === "left" ? SEEK_BACK : -SEEK_BACK;
      skip(delta);
      setRipple((r) => ({
        side: tap.zone === "left" ? "left" : "right",
        amount: r && r.side === (tap.zone === "left" ? "left" : "right") && Date.now() - r.key < 900 ? r.amount + Math.abs(delta) : Math.abs(delta),
        key: Date.now(),
      }));
      return;
    }
    if (singleTimer.current) clearTimeout(singleTimer.current);
    singleTimer.current = setTimeout(() => {
      singleTimer.current = null;
      dispatch({ type: "toggle", now: Date.now() });
    }, tap.zone === "center" ? 0 : 260);
  };

  useEffect(() => {
    if (!ripple) return;
    const id = setTimeout(() => setRipple(null), 650);
    return () => clearTimeout(id);
  }, [ripple]);

  // Next-episode countdown.
  useEffect(() => {
    if (countdown == null || countdown < 0) return;
    if (countdown === 0) {
      P.current.next?.go();
      return;
    }
    const id = setTimeout(() => setCountdown((c) => (c != null && c > 0 ? c - 1 : c)), 1000);
    return () => clearTimeout(id);
  }, [countdown]);

  // ------------------------------------------------------------ skip

  // «Пропустить заставку / пересказ», «Следующая серия» at a series' credits;
  // «Пропускать сами» skips once per range when playback has just entered it
  // (a seek or resume into the middle leaves the button), with «Вернуть».
  const skipModeNow = props.skipMode ?? "button";
  const skipDuration = vs.duration || source.media_info?.duration_seconds || source.duration_seconds || 0;
  const skipM = vs.duration > 0 && skipModeNow !== "off" ? skipTarget(source.markers, vs.time, skipDuration, !!props.next) : null;
  const skipHandled = useRef({ id: "", done: new Set<string>() });
  const [skipUndo, setSkipUndo] = useState<{ kind: "opening" | "recap"; at: number; id: string } | null>(null);
  const skipNow = useRef({ m: skipM, time: vs.time, id: source.id });
  useEffect(() => {
    skipNow.current = { m: skipM, time: vs.time, id: source.id };
  });
  const skipDone = () => {
    const id = skipNow.current.id;
    if (skipHandled.current.id !== id) skipHandled.current = { id, done: new Set() };
    return skipHandled.current.done;
  };
  useEffect(() => {
    if (skipModeNow !== "auto") return;
    const timer = setInterval(() => {
      const { m, time, id } = skipNow.current;
      if (!m) return;
      const done = skipDone();
      const k = markerKey(m);
      if (done.has(k)) return;
      done.add(k);
      if (!autoSkipDue(m, time)) return;
      if (m.kind === "ending") {
        if (P.current.autoplayNext && P.current.next) {
          if (P.current.autoplayCountdown === false) P.current.next.go();
          else setCountdown((c) => c ?? NEXT_COUNTDOWN);
        }
        return;
      }
      seek(m.end_seconds);
      setSkipUndo({ kind: m.kind, at: time, id });
    }, 500);
    return () => clearInterval(timer);
  }, [skipModeNow, seek]);
  useEffect(() => {
    if (!skipUndo) return;
    const id = setTimeout(() => setSkipUndo(null), 6000);
    return () => clearTimeout(id);
  }, [skipUndo]);
  const shownUndo = skipUndo && skipUndo.id === source.id ? skipUndo : null;
  const doSkip = () => {
    if (!skipM) return;
    skipDone().add(markerKey(skipM));
    if (skipM.kind === "ending") return props.next?.go();
    seek(skipDuration > 0 ? Math.min(skipM.end_seconds, skipDuration - 1) : skipM.end_seconds);
  };

  // ------------------------------------------------------------ render

  const duration = skipDuration;
  const qualities = source.kind === "online" ? [...(source.qualities ?? [])].sort((a, b) => b - a) : [];
  const shownTime = scrub ?? vs.time;
  const show = controls.visible || shownPaused || !shown;
  // −10 / play-pause / +30 sit at the bottom left of the bar, out of the picture.
  const info = source.media_info;
  void tracksTick;
  const compatAvailable = !!source.compat_url && mode === "native" && !!props.onCompatToggle;
  const compatSubs = cmp ? textSubtitles(info) : [];
  const subUrl = cmp && cmpSub && source.compat_url ? subsSrc(source.compat_url, cmpSub.index, cmp.start, cmpSub.burst) : null;

  // Compat subtitles: show the <track> once it is in the list.
  useEffect(() => {
    if (!el) return;
    for (const tr of Array.from(el.textTracks)) {
      if (tr.id === "compat-sub") tr.mode = "showing";
      else if (subUrl) tr.mode = "disabled";
    }
  }, [el, subUrl]);

  return (
    <div
      ref={root}
      data-testid="player"
      data-state={vs.ended ? "ended" : vs.paused ? "paused" : "playing"}
      data-compat={cmp ? "on" : "off"}
      data-compat-format={cmp ? compatFmt : ""}
      data-rebuffering={rebufView ? "true" : "false"}
      data-last-resume={lastResume ?? ""}
      data-offset={cmp ? cmp.start : 0}
      className={`fixed inset-0 select-none overflow-hidden bg-black text-white ${show ? "" : "cursor-none"}`}
      onPointerMove={(e) => {
        if (e.pointerType === "mouse") poke();
      }}
    >
      <video
        ref={bindVideo}
        src={mode === "hlsjs" ? undefined : src || undefined}
        playsInline
        preload="auto"
        controls={false}
        className="absolute inset-0 h-full w-full object-contain"
        data-testid="video"
        data-engine={mode}
        onDoubleClick={() => void toggleFullscreen()}
      >
        {(source.subtitles ?? []).map((s, i) => (
          <track key={s.url} kind="subtitles" src={s.url} srcLang={s.lang ?? undefined} label={s.label ?? s.lang ?? `#${i + 1}`} />
        ))}
        {subUrl && <track key={subUrl} id="compat-sub" kind="subtitles" src={subUrl} default label="compat" />}
      </video>

      {/* Gesture surface (under the controls). */}
      <div
        className="absolute inset-0"
        onPointerUp={onSurfaceUp}
        onDoubleClick={(e) => {
          if ((e.nativeEvent as PointerEvent).pointerType !== "touch") void toggleFullscreen();
        }}
        data-testid="player-surface"
      />

      {ripple && (
        <div
          key={ripple.key}
          aria-hidden
          className={`pointer-events-none absolute inset-y-0 flex w-1/3 items-center justify-center ${ripple.side === "left" ? "left-0 rounded-r-[50%]" : "right-0 rounded-l-[50%]"} animate-[mt-ripple_650ms_ease-out_forwards] bg-white/10`}
        >
          <span className="flex flex-col items-center gap-1 text-sm font-semibold">
            <SkipIcon seconds={ripple.side === "left" ? -10 : 10} className="text-3xl" />
            {ripple.side === "left" ? "−" : "+"}
            {ripple.amount} {t("player.web.seconds_short")}
          </span>
        </div>
      )}

      {((vs.waiting && !vs.paused) || rebufView) && shown && !props.covered && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2" data-testid="player-buffering">
          <span className="rounded-full bg-black/45 p-3 backdrop-blur-sm">
            <Spinner size={36} />
          </span>
          {rebufView && (
            <span className="rounded-lg bg-black/60 px-3 py-1.5 text-center text-sm tabular-nums" data-testid="player-rebuffer" data-pct={rebufView.pct}>
              {t("player.web.buffering", { pct: rebufView.pct })}
              <span className="block text-xs text-white/70" data-testid="player-rebuffer-stats">
                {t("player.web.buffering_stats", { ahead: Math.floor(rebufView.ahead), rate: mbit(rebufView.rate) })}
              </span>
              <RebufferTorrentLine source={source} />
              <button
                type="button"
                data-testid="player-rebuffer-play"
                onClick={() => endRebuffer.current("user", true)}
                className="pointer-events-auto mt-1 rounded-md px-2 py-0.5 text-xs font-semibold text-accent hover:bg-white/10"
              >
                {t("player.web.play_now_anyway")}
              </button>
            </span>
          )}
        </div>
      )}

      {rebufView && !props.covered && <RebufferSlowHint source={source} onLighter={props.onLighter} />}

      {bwHint && !props.covered && (
        <div className="absolute inset-x-0 top-[calc(max(env(safe-area-inset-top),0.5rem)+3.5rem)] z-20 flex justify-center px-3">
          <div role="status" data-testid="bandwidth-hint" className="flex w-full max-w-lg flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-white/10 bg-neutral-900/95 px-4 py-2.5 text-sm text-white shadow-2xl backdrop-blur">
            <span className="min-w-0 flex-1">{t("player.web.bandwidth_hint", { rate: mbit(bwHint.rate), need: mbit(bwHint.bitrate) })}</span>
            <span className="flex gap-1">
              <button
                type="button"
                data-testid="bandwidth-lighter"
                onClick={() => {
                  setBwHint(null);
                  props.onLighter?.(bwHint.rate);
                }}
                className="min-h-[36px] rounded-lg px-2.5 font-semibold text-accent hover:bg-white/10"
              >
                {t("player.web.bandwidth_lighter")}
              </button>
              <button type="button" onClick={() => setBwHint(null)} className="min-h-[36px] rounded-lg px-2.5 font-semibold text-accent hover:bg-white/10">
                {t("common.close")}
              </button>
            </span>
          </div>
        </div>
      )}

      {/* Controls */}
      <div
        className={`pointer-events-none absolute inset-0 transition-opacity duration-300 ${show && !props.covered ? "opacity-100" : "opacity-0"}`}
        data-testid="player-controls"
        data-visible={show && !props.covered ? "true" : "false"}
      >
        <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-black/75 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-44 bg-gradient-to-t from-black/85 via-black/45 to-transparent" />

        {/* Top bar */}
        <div
          className={`absolute inset-x-0 top-0 flex items-center gap-2 pl-[max(env(safe-area-inset-left),0.5rem)] pr-[max(env(safe-area-inset-right),0.75rem)] pt-[max(env(safe-area-inset-top),0.5rem)] ${show ? "pointer-events-auto" : ""}`}
        >
          <IconBtn label={t("player.web.back")} onClick={props.onBack} testId="player-back">
            <ChevronLeft className="text-[26px]" />
          </IconBtn>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-bold leading-tight drop-shadow sm:text-lg" data-testid="player-title">
              {props.title}
            </p>
            {props.subtitle && <p className="truncate text-xs text-white/75 sm:text-sm">{props.subtitle}</p>}
            {vs.paused && !vs.ended && <PausedStats source={source} />}
          </div>
          {canPip(el) && (
            <IconBtn label={t("player.web.pip")} onClick={() => el && void togglePip(el)} testId="player-pip">
              <PipIcon className="text-[22px]" />
            </IconBtn>
          )}
        </div>


        {/* Bottom bar */}
        <div
          className={`absolute inset-x-0 bottom-0 space-y-1 pb-[max(env(safe-area-inset-bottom),0.5rem)] pl-[max(env(safe-area-inset-left),0.75rem)] pr-[max(env(safe-area-inset-right),0.75rem)] sm:px-5 ${show ? "pointer-events-auto" : ""}`}
        >
          <SeekBar
            time={shownTime}
            duration={duration}
            buffered={vs.buffered}
            onScrub={(s) => {
              setScrub(s);
              poke();
            }}
            onCommit={(s) => {
              setScrub(null);
              seek(s);
            }}
            label={t("player.web.seek")}
            chapters={fileChapters(source.media_info?.chapters, duration)}
            chapterName={(i, title) => (title ? t("chapters.titled", { n: i + 1, title }) : t("chapters.n", { n: i + 1 }))}
          />
          <div className="flex items-center gap-1">
            {props.prev && (
              <IconBtn label={`${t("player.prev_episode")} · ${props.prev.code}`} onClick={props.prev.go} testId="player-prev-episode">
                <NextIcon className="-scale-x-100 text-[22px]" />
              </IconBtn>
            )}
            <IconBtn label={t("player.web.back10")} onClick={() => skip(SEEK_BACK)} testId="player-back10">
              <SkipIcon seconds={SEEK_BACK} className="text-[22px]" />
            </IconBtn>
            <IconBtn label={shownPaused ? t("player.web.play") : t("player.web.pause")} onClick={togglePlay} testId="player-toggle">
              {shownPaused ? <PlayIcon className="text-[22px]" /> : <PauseIcon className="text-[22px]" />}
            </IconBtn>
            <IconBtn label={t("player.web.forward30")} onClick={() => skip(SEEK_FORWARD)} testId="player-forward30">
              <SkipIcon seconds={SEEK_FORWARD} className="text-[22px]" />
            </IconBtn>
            {props.next && (
              <IconBtn label={`${t("player.next_episode")} · ${props.next.code}`} onClick={props.next.go} testId="player-next-episode">
                <NextIcon className="text-[22px]" />
              </IconBtn>
            )}
              
            <IconBtn label={vs.muted || vs.volume === 0 ? t("player.web.unmute") : t("player.web.mute")} onClick={toggleMute} testId="player-mute" className="hidden sm:flex">
              {vs.muted || vs.volume === 0 ? <MuteIcon className="text-[22px]" /> : <VolumeIcon className="text-[22px]" />}
            </IconBtn>
            {VOLUME_SETTABLE && (
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={vs.muted ? 0 : vs.volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                aria-label={t("player.web.volume")}
                className="hidden w-24 accent-[rgb(var(--mt-accent))] md:block"
              />
            )}
            <p className="ml-2 whitespace-nowrap text-xs font-medium tabular-nums text-white/90 sm:text-sm" data-testid="player-time">
              {formatClock(shownTime)}
              <span className="text-white/55"> / {duration ? formatClock(duration) : "--:--"}</span>
            </p>
            <div className="ml-auto flex items-center gap-0.5">
              {qualities.length > 1 && (
                <MenuBtn
                  open={controls.menu === "quality"}
                  onToggle={() => dispatch({ type: "menu", menu: "quality", now: Date.now() })}
                  label={t("sources.player.quality")}
                  testId="player-quality"
                  badge={quality ? `${quality}p` : null}
                >
                  <span className="text-[13px] font-bold">HD</span>
                </MenuBtn>
              )}
              <MenuBtn
                open={controls.menu === "speed"}
                onToggle={() => dispatch({ type: "menu", menu: "speed", now: Date.now() })}
                label={t("player.web.speed")}
                testId="player-speed"
                badge={vs.rate !== 1 ? `${vs.rate}×` : null}
              >
                <SpeedIcon className="text-[22px]" />
              </MenuBtn>
              {(info?.audio.length ?? 0) > 1 || (audioTracks(el)?.length ?? 0) > 1 || compatAvailable ? (
                <MenuBtn
                  open={controls.menu === "audio"}
                  onToggle={() => dispatch({ type: "menu", menu: "audio", now: Date.now() })}
                  label={t("player.web.audio")}
                  testId="player-audio"
                >
                  <AudioTrackIcon className="text-[22px]" />
                </MenuBtn>
              ) : null}
              {(el?.textTracks.length ?? 0) > 0 || (info?.subtitles.length ?? 0) > 0 || compatSubs.length > 0 ? (
                <MenuBtn
                  open={controls.menu === "subs"}
                  onToggle={() => dispatch({ type: "menu", menu: "subs", now: Date.now() })}
                  label={t("player.web.subtitles")}
                  testId="player-subs"
                >
                  <SubtitlesIcon className="text-[22px]" />
                </MenuBtn>
              ) : null}
              {source.kind !== "online" && (
                <MenuBtn
                  open={controls.menu === "download"}
                  onToggle={() => dispatch({ type: "menu", menu: "download", now: Date.now() })}
                  label={t("devicedl.menu")}
                  testId="player-download"
                  badge={downloadBadge(source)}
                >
                  <DownloadIcon className="text-[22px]" />
                </MenuBtn>
              )}
              {canFullscreen(el) && (
                <IconBtn label={fs ? t("player.web.exit_fullscreen") : t("player.web.fullscreen")} onClick={() => void toggleFullscreen()} testId="player-fullscreen">
                  {fs ? <ExitFullscreenIcon className="text-[22px]" /> : <FullscreenIcon className="text-[22px]" />}
                </IconBtn>
              )}
            </div>
          </div>
        </div>

        {controls.menu === "download" && show && (
          <PlayerDownloadMenu
            source={source}
            onClose={() => dispatch({ type: "menu", menu: null, now: Date.now() })}
            device={{
              title: props.title,
              subtitle: props.subtitle,
              poster: props.poster ?? null,
              // Save what plays here: the compat stream (with the chosen audio) when on.
              playing: () => (compatOn && source.compat_url ? { mode: "compat", audio: cmpRef.current?.audio ?? null } : { mode: "original", audio: null }),
            }}
          />
        )}
        {controls.menu && controls.menu !== "download" && show && (
          <MenuPanel
            menu={controls.menu}
            video={el}
            info={info}
            rate={vs.rate}
            locale={locale}
            qualities={qualities}
            quality={quality}
            onQuality={(q) => void switchQuality(q)}
            compat={{
              available: compatAvailable,
              on: !!cmp,
              // No audio= (ffprobe info came later): the server plays the file's default.
              audio: cmp ? (cmp.audio ?? defaultAudioIndex(info)) : null,
              subs: cmpSub?.index ?? null,
              textSubs: compatSubs,
              canSwitch: compatAvailable && !!props.onCompatAudio,
              onToggle: () => props.onCompatToggle?.(!cmp),
              onAudio: switchCompatAudio,
              onRemember: (tr) => writeAudioChoice(props.audioKey, tr),
              onSubs: (i) => {
                const v = video.current;
                setCmpSub(i == null ? null : { index: i, burst: (v?.currentTime ?? 0) + 60 });
              },
            }}
            onClose={() => dispatch({ type: "menu", menu: null, now: Date.now() })}
            onChanged={() => {
              setTracksTick((n) => n + 1);
              sync();
            }}
          />
        )}
      </div>

      {shownUndo && !props.covered && countdown == null && (
        <div
          role="status"
          data-testid="skip-undo"
          className="absolute bottom-[calc(7.5rem+env(safe-area-inset-bottom))] right-[max(env(safe-area-inset-right),0.75rem)] z-10 flex min-h-[44px] items-center gap-3 rounded-xl border border-white/25 bg-black/70 pl-4 pr-1.5 text-white shadow-xl backdrop-blur sm:right-5"
        >
          {t(`skip.skipped.${shownUndo.kind}`)}
          <button
            type="button"
            onClick={() => {
              seek(shownUndo.at);
              setSkipUndo(null);
            }}
            className="min-h-[36px] rounded-lg bg-white/15 px-3 font-semibold hover:bg-white hover:text-black"
          >
            {t("skip.undo")}
          </button>
        </div>
      )}
      {skipM && !shownUndo && !props.covered && countdown == null && (
        <button
          type="button"
          onClick={doSkip}
          data-testid="skip-opening"
          data-kind={skipM.kind}
          className="absolute bottom-[calc(7.5rem+env(safe-area-inset-bottom))] right-[max(env(safe-area-inset-right),0.75rem)] z-10 flex min-h-[44px] items-center gap-2 rounded-xl border border-white/25 bg-black/60 px-4 font-semibold text-white shadow-xl backdrop-blur transition hover:bg-white hover:text-black sm:right-5"
        >
          <NextIcon className="text-lg" />
          {skipM.kind === "opening" && source.provider?.kind === "anime" ? t("sources.player.skip_opening") : t(`skip.${skipM.kind}`)}
        </button>
      )}

      {toast && (
        <div role="status" data-testid="player-toast" className="absolute left-1/2 top-[calc(max(env(safe-area-inset-top),0.5rem)+4rem)] z-20 -translate-x-1/2 rounded-xl bg-neutral-900/95 px-4 py-2 text-sm text-white shadow-xl">
          {toast}
        </div>
      )}

      {countdown != null && props.next && (
        <NextCard next={props.next} countdown={countdown} onCancel={() => setCountdown(-1)} />
      )}

      {props.children}
    </div>
  );
}

// ---------------------------------------------------------------- pieces

function IconBtn({
  label,
  onClick,
  children,
  big,
  className = "",
  testId,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  big?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      data-testid={testId}
      className={`flex shrink-0 items-center justify-center rounded-full text-white transition hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
        big ? "h-14 w-14 bg-black/25 backdrop-blur-sm" : "h-11 w-11"
      } ${className}`}
    >
      {children}
    </button>
  );
}

function MenuBtn({
  open,
  onToggle,
  label,
  children,
  testId,
  badge,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  children: ReactNode;
  testId?: string;
  badge?: string | null;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-expanded={open}
      onClick={onToggle}
      data-testid={testId}
      className={`relative flex h-11 min-w-[2.75rem] shrink-0 items-center justify-center rounded-full px-1 transition hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
        open ? "bg-white/20 text-accent" : "text-white"
      }`}
    >
      {children}
      {badge && <span className="absolute -top-0.5 right-0 rounded bg-accent px-1 text-[10px] font-bold leading-4 text-on-accent">{badge}</span>}
    </button>
  );
}

function SeekBar({
  time,
  duration,
  buffered,
  onScrub,
  onCommit,
  label,
  chapters = null,
  chapterName,
}: {
  time: number;
  duration: number;
  buffered: [number, number][];
  onScrub: (s: number) => void;
  onCommit: (s: number) => void;
  label: string;
  /** The file's chapters: ticks on the bar, the name in the time bubble. */
  chapters?: Chapter[] | null;
  chapterName?: (index: number, title: string | null) => string;
}) {
  const ticks = chapterTicks(chapters, duration);
  const bar = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [hover, setHover] = useState<{ x: number; s: number; w: number } | null>(null);
  /** A finger is dragging: bigger thumb and a time bubble above it. */
  const [touchAt, setTouchAt] = useState<{ x: number; s: number; w: number } | null>(null);
  const pct = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;
  const at = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return { x: f * r.width, s: f * duration, w: r.width };
  };
  const bubble = touchAt ?? hover;
  return (
    <div className="group relative" data-testid="player-seek-wrap">
      {bubble && duration > 0 && (
        <span
          className={`pointer-events-none absolute -translate-x-1/2 rounded bg-black/80 tabular-nums ${touchAt ? "-top-9 px-2.5 py-1 text-base font-semibold" : "-top-4 px-1.5 py-0.5 text-xs"}`}
          style={{ left: Math.max(28, Math.min(bubble.x, bubble.w - 28)) }}
          data-testid="player-seek-bubble"
        >
          {formatClock(bubble.s)}
          {chapters && chapterName && chapterIndexAt(chapters, bubble.s) >= 0 && (
            <span className="ml-1.5 font-normal opacity-80" data-testid="player-seek-chapter">
              · {chapterName(chapterIndexAt(chapters, bubble.s), chapters[chapterIndexAt(chapters, bubble.s)]!.title)}
            </span>
          )}
        </span>
      )}
      <div
        ref={bar}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(time)}
        aria-valuetext={`${formatClock(time)} / ${formatClock(duration)}`}
        data-testid="player-seek"
        // Tall hit area (thin line drawn inside): a finger must hit it easily.
        className="relative h-9 cursor-pointer touch-none outline-none focus-visible:ring-2 focus-visible:ring-accent sm:h-7"
        onPointerDown={(e) => {
          if (!duration) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = at(e.clientX);
          if (e.pointerType !== "mouse") setTouchAt(p);
          onScrub(p.s);
        }}
        onPointerMove={(e) => {
          if (!duration) return;
          const p = at(e.clientX);
          if (e.pointerType === "mouse") setHover(p);
          if (dragging.current) {
            if (e.pointerType !== "mouse") setTouchAt(p);
            onScrub(p.s);
          }
        }}
        onPointerLeave={() => setHover(null)}
        onPointerUp={(e) => {
          setTouchAt(null);
          if (!dragging.current) return;
          dragging.current = false;
          onCommit(at(e.clientX).s);
        }}
        onPointerCancel={() => {
          setTouchAt(null);
          if (!dragging.current) return;
          dragging.current = false;
          onCommit(time);
        }}
        onKeyDown={(e) => {
          if (!duration) return;
          const step = e.key === "ArrowLeft" ? -10 : e.key === "ArrowRight" ? 10 : e.key === "Home" ? -Infinity : e.key === "End" ? Infinity : 0;
          if (!step) return;
          e.preventDefault();
          onCommit(Math.max(0, Math.min(duration, time + step)));
        }}
      >
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/25 transition-[height] group-hover:h-1.5">
          {bufferedSegments(buffered, duration).map((b, i) => (
            <div key={i} className="absolute inset-y-0 bg-white/35" style={{ left: `${b.left}%`, width: `${b.width}%` }} data-testid="player-buffered" />
          ))}
          <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${pct}%` }} />
          {ticks.map((p) => (
            <div key={p} className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-black/70" style={{ left: `${p}%` }} data-testid="player-chapter-tick" />
          ))}
        </div>
        <div
          className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow ring-2 ring-black/30 transition-transform group-hover:scale-110 ${touchAt ? "h-6 w-6" : "h-4 w-4 sm:h-3.5 sm:w-3.5"}`}
          style={{ left: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function MenuPanel({
  menu,
  video,
  info,
  rate,
  locale,
  qualities,
  quality,
  onQuality,
  onClose,
  onChanged,
  compat,
}: {
  compat: CompatMenu;
  menu: Exclude<Menu, null | "download">;
  video: HTMLVideoElement | null;
  info: MediaInfo | null;
  rate: number;
  locale: string;
  qualities: number[];
  quality: number | null;
  onQuality: (q: number) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  let title: string;
  let items: { key: string; label: string; on: boolean; pick?: () => void }[] = [];
  let note: string | null = null;

  if (menu === "quality") {
    title = t("sources.player.quality");
    const cur = quality ?? qualities[0];
    items = qualities.map((q) => ({ key: String(q), label: `${q}p`, on: q === cur, pick: q === cur ? undefined : () => onQuality(q) }));
  } else if (menu === "speed") {
    title = t("player.web.speed");
    items = SPEEDS.map((s) => ({
      key: String(s),
      label: s === 1 ? t("player.web.speed_normal") : `${s}×`,
      on: Math.abs(rate - s) < 0.01,
      pick: () => {
        if (video) video.playbackRate = s;
      },
    }));
  } else if (menu === "audio") {
    title = t("player.web.audio");
    const list = audioTracks(video);
    if (compat.on) {
      // Compat: the file's tracks (ffprobe); switching restarts the stream here.
      items = (info?.audio ?? []).map((a) => ({
        key: `c${a.index}`,
        label: trackLabel(a, locale),
        on: a.index === compat.audio,
        pick: a.index === compat.audio ? undefined : () => compat.onAudio(a.index),
      }));
      if (items.length > 1) note = t("player.web.compat.audio_hint");
      else if (!info) note = t("pcplay.audio_reading");
    } else if (list && list.length > 0) {
      for (let i = 0; i < list.length; i++) {
        const tr = list[i]!;
        const mi = info?.audio[i];
        items.push({
          key: tr.id || String(i),
          label: trackLabel({ title: mi?.title ?? tr.label, language: tr.language || mi?.language }, locale),
          on: tr.enabled,
          pick: () => {
            for (let j = 0; j < list.length; j++) list[j]!.enabled = j === i;
            compat.onRemember(mi ?? { language: tr.language || null, title: tr.label || null });
          },
        });
      }
    } else {
      // The browser can't switch tracks of the original stream: another
      // track plays through the server (compat), like in compat mode.
      const main = info?.audio.find((a) => a.default) ?? info?.audio[0];
      items = (info?.audio ?? []).map((a, i) => ({
        key: String(i),
        label: trackLabel(a, locale),
        on: a === main,
        pick: a === main || !compat.canSwitch ? undefined : () => compat.onAudio(a.index),
      }));
      if (items.length > 1) note = compat.canSwitch ? t("player.web.compat.audio_hint") : compat.available ? null : t("player.web.audio_locked");
      else if (!info) note = t("pcplay.audio_reading");
    }
    if (compat.available) items.push({ key: "compat", label: t("player.web.compat.toggle"), on: compat.on, pick: compat.onToggle });
  } else {
    title = t("player.web.subtitles");
    const tracks = video ? Array.from(video.textTracks) : [];
    if (compat.on && compat.textSubs.length > 0) {
      items.push({ key: "off", label: t("player.web.subtitles_off"), on: compat.subs == null, pick: () => compat.onSubs(null) });
      for (const sub of compat.textSubs)
        items.push({ key: `c${sub.index}`, label: trackLabel(sub, locale), on: compat.subs === sub.index, pick: () => compat.onSubs(sub.index) });
    } else if (tracks.length) {
      const any = tracks.some((tr) => tr.mode === "showing");
      items.push({ key: "off", label: t("player.web.subtitles_off"), on: !any, pick: () => tracks.forEach((tr) => (tr.mode = "disabled")) });
      tracks.forEach((tr, i) =>
        items.push({
          key: tr.id || String(i),
          label: trackLabel({ title: tr.label, language: tr.language }, locale),
          on: tr.mode === "showing",
          pick: () => tracks.forEach((x, j) => (x.mode = j === i ? "showing" : "disabled")),
        }),
      );
    } else {
      items = (info?.subtitles ?? []).map((s, i) => ({ key: String(i), label: trackLabel(s, locale), on: false }));
      note = t("player.web.subtitles_locked");
    }
  }

  return (
    <div
      className="pointer-events-auto absolute bottom-[calc(6.5rem+env(safe-area-inset-bottom))] right-[max(env(safe-area-inset-right),0.75rem)] z-10 max-h-[60vh] w-64 overflow-y-auto rounded-2xl border border-white/10 bg-neutral-900/95 p-1.5 text-white shadow-2xl backdrop-blur sm:right-5"
      role="menu"
      aria-label={title}
      data-testid={`player-menu-${menu}`}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-white/55">{title}</p>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="menuitemradio"
          aria-checked={it.on}
          disabled={!it.pick}
          onClick={() => {
            it.pick?.();
            onChanged();
            onClose();
          }}
          className="flex min-h-[44px] w-full items-center gap-2 rounded-xl px-3 text-left text-sm hover:bg-white/10 disabled:cursor-default disabled:hover:bg-transparent"
        >
          <span className="w-5 shrink-0 text-accent">{it.on && <CheckIcon />}</span>
          <span className={`min-w-0 flex-1 truncate ${it.pick || it.on ? "" : "text-white/60"}`}>{it.label}</span>
        </button>
      ))}
      {note && <p className="px-3 pb-2 pt-1 text-xs leading-snug text-white/60">{note}</p>}
    </div>
  );
}

interface CompatMenu {
  available: boolean;
  on: boolean;
  audio: number | null;
  subs: number | null;
  textSubs: MediaStream[];
  /** Off: picking a track of the original stream switches to compat with it. */
  canSwitch: boolean;
  onToggle: () => void;
  onAudio: (index: number) => void;
  /** Remember a natively switched track for this title. */
  onRemember: (track: { language: string | null; title: string | null }) => void;
  onSubs: (index: number | null) => void;
}

function NextCard({ next, countdown, onCancel }: { next: NextUpInfo; countdown: number; onCancel: () => void }) {
  const { t } = useI18n();
  return (
    <div
      className="absolute bottom-[calc(7rem+env(safe-area-inset-bottom))] right-[max(env(safe-area-inset-right),0.75rem)] z-10 w-[min(22rem,calc(100%-1.5rem))] rounded-2xl border border-white/10 bg-neutral-900/95 p-4 text-white shadow-2xl backdrop-blur sm:right-5"
      data-testid="next-episode"
      role="status"
    >
      <p className="text-xs font-semibold uppercase tracking-wider text-accent">{t("player.web.next_episode")}</p>
      <p className="mt-1 truncate font-bold">
        {next.code}
        {next.name ? ` · ${next.name}` : ""}
      </p>
      {countdown > 0 && <p className="mt-0.5 text-sm text-white/70">{t("player.web.next_in", { n: countdown })}</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={next.go}
          data-testid="next-play"
          className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl bg-accent px-4 font-semibold text-on-accent hover:bg-accent-strong"
        >
          <NextIcon />
          {t("player.web.play_now")}
        </button>
        {countdown > 0 && (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-white/10 px-4 font-semibold hover:bg-white/20"
          >
            {t("common.cancel")}
          </button>
        )}
      </div>
    </div>
  );
}

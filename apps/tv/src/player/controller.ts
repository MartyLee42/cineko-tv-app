// The TV's playback engine: runs the flow (search → prepare → play), owns the
// <video> element while the player is shown, answers remote commands
// synchronously and reports PlaybackState. React components subscribe to it.
import type { Episode, PlaybackLoading, PlaybackSource, PlaybackState, Release, Schemas } from "@martytv/contracts";
import { isAndroid, skipTarget } from "@martytv/media-types";
import { setMediaContext } from "@martytv/ui";
import { hasAudio } from "./audio";
import { tvVolume } from "./volume";
import { isRealEnd, isUnexplainedDrop, isUnexplainedJump, seekMissed } from "./glitch";
import { attachHlsJs, reloadUrl, streamMode, type HlsHandle } from "./stream";

type Track = Schemas["Track"];
import type { RouteMemory } from "../catalog/nav";
import { pickSeason } from "../catalog/seasons";
import {
  assessSource,
  audioProbeAnswers,
  decodeFailure,
  engineProbe,
  lighterInstead,
  nextRelease,
  RATE_HEADROOM,
  smootherInstead,
  sourceDecodeCost,
  sourceSmoothToken,
  tooHeavyHere,
  videoUndecodable,
  type Probe,
  type RankEnv,
  type Support,
} from "./codecs";
import {
  absTime,
  audioIndexOf,
  audioUndecodable,
  canPlayCompat,
  compatPlan,
  compatPrefStore,
  compatSeek,
  compatServer,
  compatSrc,
  compatUrlOf,
  fetchStreamStart,
  pickCompatAudio,
  rangesOf,
  sourceCodecLabel,
  trackIdOf,
  videoConvertNeeded,
  wantCompat,
  type CompatPref,
} from "./compat";
import {
  bandwidthCheck,
  bufferedAhead,
  estimateRate,
  rateWarmupMs,
  sessionSample,
  slowHintPref,
  rateStore,
  rebufferDead,
  rebufferDone,
  rebufferOutrun,
  rebufferPercent,
  rebufferTarget,
  sessionRate,
  slowHintAllowed,
  slowHintExpired,
  SLOW_LOG0,
  sourceBitrate,
  STALL_WINDOW,
  type RateSample,
  type SlowHintLog,
} from "./rebuffer";
import { devicePrefs } from "../settings/devicePrefs";
import { clearStutter, noteStutter, provenSmooth, readFrames, STUTTER0, stutterStep, thisSmoothView, type FrameCounters, type StutterState } from "./smooth";
import {
  apiErrorCode,
  cachedMedia,
  cachedReleases,
  cachedSeason,
  createSource,
  fetchReleases,
  findEpisode,
  cancelSource,
  getSource,
  loadMedia,
  loadSeason,
  patchQuality,
  releaseQuery,
} from "./data";
import { nextEpisode as resolveNext, packCovers, prevEpisode as resolvePrev, type EpisodeRef } from "./episodes";
import { episodeLabel, releaseRow } from "./format";
import { loadTracker, stageOf } from "./loading";
import { normLang, pickPreferredAudio, trackLabel } from "./tracks";
import { loadPreferences } from "../profile/settings";
import { IDLE, isBusy, reduceFlow, type Flow, type FlowAction, type PlayContext } from "./session";
import { launchOnMsx, playOnMsx } from "../players/msx";
import { absoluteStreamUrl, currentEnv, currentPlayers, defaultPlayerStore, externalRoute, intentUrl, resolvePlayer, type PlayerChoice } from "../players/select";
import { ProgressReporter, type Snapshot, type Transport } from "../watch/reporter";
import { apiTransport, refreshWatchData } from "../watch/api";
import { MIN_RESUME } from "../watch/resume";
import { isCompleted } from "../watch/rating";
import { ratingQueue } from "../watch/stores";

export const POLL_MS = 1000;
/** A torrent with no connected peer and no data this long is given up on. */
export const DEAD_TORRENT_MS = 30_000;
const MAX_DEAD_SWITCHES = 3;
const PREPARE_TIMEOUT = 3 * 60_000;
/** Refresh the stream URL this long before it expires. */
const EXPIRY_MARGIN = 60_000;
/** Retries of a stream URL refresh after a playback error (backoff grows). */
const REFRESH_RETRIES = 4;
const REFRESH_BACKOFF = 1500;
/** Seconds of playback after which "no audio decoded" means it can't decode it. */
const AUDIO_CHECK_AFTER = 4;
/**
 * A torrent source without media_info yet (first play of a file: the server
 * runs ffprobe only once someone GETs the source): wait this long for it
 * before the first load, so a DTS/AC3 file starts in compat from the first
 * frame. After that, play the original and keep polling in the background.
 */
export const INFO_WAIT_MS = 8_000;
const INFO_POLL_MS = 1_000;
const INFO_BG_POLL_MS = 3_000;
const INFO_GIVE_UP_MS = 90_000;
/** Premature-end recoveries before giving up with a network error. */
const MAX_RECOVERIES = 4;
/**
 * A load with no first frame yet whose element shows no sign of life (no
 * new buffered data, no readyState change) this long is reopened with a
 * fresh URL — e.g. resuming after a long pause, when the engine opened the
 * stream, read the header and then never asked for more. Each retry waits
 * one step longer (a slow torrent still finding peers); it never fails the
 * playback (the loading screen's own «dead torrent» check does that).
 */
export const FIRST_LOAD_STUCK_MS = 30_000;
/** After a played-out rebuffer, a native stall this long brings «Буферизация» back. */
export const QUIET_STALL_MS = 15_000;
/** Frame counters are sampled every this many ticks (500 ms each). */
const FRAME_EVERY = 4;
/** No frame judgement this long after a start / seek / new stream (decoders warm up, drop a few). */
const FRAME_GRACE_MS = 10_000;
/** «Картинка подтормаживает…» hides by itself after this long. */
const STUTTER_HINT_MS = 20_000;

export type ChangeKind = "flow" | "playback" | "progress";
type Listener = (kind: ChangeKind) => void;

export interface TrackInfo {
  audio: Track[];
  subtitles: Track[];
  audioId: string | null;
  subtitleId: string | null;
  /** The engine exposes the tracks and can switch them. */
  canAudio: boolean;
  canSubtitles: boolean;
}

export interface RemotePlay {
  media_id: string;
  episode_id?: string;
  source_id?: string;
  /** A release chosen on the phone: the TV creates its source (no search). */
  release_id?: string;
  /** Online variants: the wanted quality for release_id. */
  quality?: number;
  position_seconds?: number;
}

interface EngineAudioTrack {
  id: string;
  label: string;
  language: string;
  enabled: boolean;
}
interface EngineList<T> {
  length: number;
  [i: number]: T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * No measured rate yet: the device profile's bitrate limit (manual, or the
 * server's unmeasured-TV default) as the rate the TV ranks against.
 */
function deviceCapRate(): number | null {
  const cap = devicePrefs.get()?.effective.max_bitrate_bps;
  return cap && cap > 0 ? cap / RATE_HEADROOM : null;
}

function memKey(ctx: PlayContext): string {
  return `release:${ctx.season ?? ""}:${ctx.episode ?? ""}`;
}

export class PlayerController {
  flow: Flow = IDLE;
  /** Codec verdict for the playing source (early warning). */
  support: Support | null = null;
  video: HTMLVideoElement | null = null;

  private gen = 0;
  /** Bumped when the player is left: the next load of the same title starts its progress at 0. */
  private loadSeq = 0;
  private listeners = new Set<Listener>();
  private mem: RouteMemory | undefined;
  /** Online variant id → quality chosen in «Смотреть онлайн» (sent on POST /playback/sources). */
  private onlineQuality = new Map<string, number>();
  private probeCache: Probe | null = null;
  // Per loaded source:
  private loadedUrl: string | null = null;
  private pendingSeek: number | null = null;
  /** A seek applied before the engine could play (load / metadata): checked once it plays. */
  private seekCheck: { target: number; retried: boolean } | null = null;
  /** User / remote seeks so far (a late session resume must not undo one). */
  private seeks = 0;
  private freshUrl: string | null = null;
  private refreshes = 0;
  private lastGood = 0;
  /** Until when a big position jump is expected (user/remote seek, new load). */
  private seekAllowedUntil = 0;
  /** Where to continue after a premature end / jump (the last trusted spot). */
  private resumeAt: number | null = null;
  /** Premature-end recoveries in a row (gives up after a few). */
  private recoveries = 0;
  private recoverFrom = 0;
  private audioChecked = false;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private detachVideo: (() => void) | null = null;
  /** The last picture, kept up while a new stream loads mid-film (see holdFrame). */
  private frameCanvas: HTMLCanvasElement | null = null;
  private frameHeld = false;
  /** hls.js on engines without native HLS (online sources). */
  private hls: HlsHandle | null = null;
  private hlsSeq = 0;
  /** Continues a play once the user picked a player ("Play with…"). */
  private pendingChoice: ((c: PlayerChoice) => void) | null = null;
  /** The current source showed its first frame (the big loading screen is over). */
  started = false;
  /** The current source's video metadata is known. */
  metadata = false;
  /** media.play without a position: resume where the profile left off. */
  private autoResume = false;
  /** Watch progress of the built-in player (sessions + reports). */
  readonly reporter: ProgressReporter;
  /** Last known position of the loaded video (for the final report). */
  private lastSnap: Snapshot | null = null;

  // Compat audio (server AAC transcode, see compat.ts): the playing stream's
  // keyframe offset, audio stream index and whether its video is re-encoded
  // to H.264 (video=h264); null = the original file.
  private compat: { audio: number | null; offset: number; video: boolean } | null = null;
  /** Absolute target while a compat stream (re)starts (HEAD for its offset). */
  private compatPending: number | null = null;
  /** Whether the pending compat restart starts playing. */
  private compatPlay = false;
  private compatSeq = 0;
  /** Compat was tried after an error for this source (once). */
  private compatTried = false;
  /** A decode error asked for the server's video conversion although the probe said the video decodes (once per source). */
  private compatVideoForced = false;
  /**
   * Polling the source for media_info (see INFO_WAIT_MS). `loaded`: the
   * up-front wait is over (the original stream was loaded or may be).
   */
  private infoWait: { gen: number; id: string; at: number; loaded: boolean } | null = null;
  /** Absolute position the current stream was loaded at (the no-sound check). */
  private loadedAt = 0;

  // Rebuffering to a threshold and the bandwidth estimate (rebuffer.ts).
  /** `shown`: the highest «Буферизация N%» shown in this rebuffer (the buffered end may shrink: never back). */
  private rebuf: { since: number; target: number; canPlayThrough: boolean; shown: number; end: number; grewAt: number; at: number } | null = null;
  /** Rebuffers ended on a plateau lately (each makes the next plateau wait longer). */
  private plateaus = 0;
  private plateauAt = 0;
  /** A stall right after a seek: becomes a rebuffer if it lasts > 3 s. */
  private stallAt: number | null = null;
  /**
   * After a «Буферизация» ended on its own: until the viewer seeks again, a
   * short native stall is not a new rebuffer (no pause, no spinner) — the
   * picture stays and the engine catches up. Only a long starvation
   * (QUIET_STALL_MS) brings «Буферизация» back. One overlay per seek, not a
   * 99 % ↔ picture flicker.
   */
  private quiet = false;
  private lastStall: number | null = null;
  private stalls: number[] = [];
  private seekedAt = 0;
  private rateSamples: RateSample[] = [];
  /** Rate estimates of this session taken while the buffer was short (the link was the limit). */
  private rateEstimates: number[] = [];
  private lastRate: number | null = null;
  /** No rate estimates before this (ms): see rateWarmupMs. */
  private rateFrom = 0;
  private lowSince: number | null = null;
  /** The visible slow-link hint (`at`: shown / last touched). */
  private slow: { rate: number; bitrate: number; at: number } | null = null;
  private slowLog: SlowHintLog = SLOW_LOG0;
  /** Dropped-frame watch of this source (smooth.ts). */
  private frames: StutterState = STUTTER0;
  private frameTicks = 0;
  private lastFrames: FrameCounters | null = null;
  /** «Картинка подтормаживает — включить более лёгкую раздачу?» (`at`: shown / last touched). Once per source. */
  private stutter: { at: number } | null = null;
  private stutterSeen = false;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  /** «Выбрать раздачу полегче»: the picker ranks releases under this rate first. */
  lighterRate: number | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    transport: Transport = apiTransport,
  ) {
    this.reporter = new ProgressReporter(transport);
  }

  /** Where the built-in player is (null when no video plays). */
  snapshot(): Snapshot | null {
    const v = this.video;
    const f = this.flow;
    if (!v || f.phase !== "playing" || f.ctx.player !== "builtin" || this.loadedUrl === null) return null;
    const position = this.resumeAt ?? this.pendingSeek ?? (v.currentTime > 0 || this.started ? this.trustedPosition() : f.startAt);
    const d = isFinite(v.duration) && v.duration > 0 ? v.duration : knownDuration(f.source);
    const snap = { position, duration: this.compat ? knownDuration(f.source) : d, paused: v.paused && !this.rebuf };
    this.lastSnap = snap;
    return snap;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(kind: ChangeKind) {
    this.listeners.forEach((l) => l(kind));
  }

  private probe(): Probe {
    return this.video ? engineProbe(this.video) : (this.probeCache ??= engineProbe());
  }

  private dispatch(a: FlowAction) {
    let prev = this.flow;
    // An error while playing must not lose the spot: "another release" and the
    // picker continue from where the viewer really was.
    if ((a.type === "fail" || a.type === "unplayable") && prev.phase === "playing") {
      const at = this.trustedPosition();
      if (at > 5) this.flow = prev = reduceFlow(prev, { type: "ctx", patch: { start_at: Math.floor(at) } });
    }
    const next = reduceFlow(prev, a);
    if (next === prev) return;
    const newSource = next.phase === "playing" && (prev.phase !== "playing" || prev.source.id !== next.source.id);
    if (prev.phase === "playing" && (next.phase !== "playing" || newSource)) this.endSession();
    this.flow = next;
    if (newSource) this.onPlaying(next.source);
    if (next.phase !== "playing" && prev.phase === "playing") this.unload();
    this.emit("flow");
  }

  /** True while a remote command must not interrupt without `force`. */
  busy(): boolean {
    return isBusy(this.flow);
  }

  // ------------------------------------------------------------------ flow entry points

  /** Opens the release picker (from Details). `mem` remembers the choice. */
  pick(ctx: PlayContext, mem?: RouteMemory) {
    this.autoResume = false;
    this.lighterRate = null;
    this.gen++;
    this.mem = mem;
    this.dispatch({ type: "pick", ctx });
  }

  /** The release last played for this title/episode (from Details memory). */
  remembered(ctx: PlayContext): string | undefined {
    return this.mem?.get<string>(memKey(ctx));
  }

  /** The player for ctx: a given choice, the one already chosen, the default, or "ask". */
  private choiceFor(ctx: PlayContext, choice?: PlayerChoice): PlayerChoice | "ask" {
    if (choice) return choice;
    if (ctx.player) return { player: ctx.player, ...(ctx.app ? { app: ctx.app } : {}) };
    const r = resolvePlayer(null, defaultPlayerStore.get(), currentPlayers());
    return "player" in r ? { player: r.player } : "ask";
  }

  private withChoice(ctx: PlayContext, c: PlayerChoice): PlayContext {
    return { ...ctx, player: c.player, app: c.player === "external" ? (c.app ?? "system") : null };
  }

  /** Shows the "Play with…" chooser, then continues with the choice. */
  private ask(ctx: PlayContext, release: Release | null, auto: boolean, then: (c: PlayerChoice) => void) {
    this.gen++;
    this.pendingChoice = then;
    this.dispatch({ type: "choose", ctx, release, auto });
  }

  /** "Play with…" on a release (long-press OK): always shows the chooser. */
  playWith(ctx: PlayContext, release: Release) {
    const auto = this.flow.phase !== "picker";
    this.ask(ctx, release, auto, (ch) => this.playRelease(ctx, release, ctx.start_at ?? 0, ch));
  }

  /** The user picked a player in the chooser. */
  choosePlayer(c: PlayerChoice) {
    const then = this.pendingChoice;
    this.pendingChoice = null;
    then?.(c);
  }

  /** Whether playback was handed to MSX / an external app (no local controls). */
  handedOff(): boolean {
    const f = this.flow;
    return f.phase === "playing" && f.ctx.player !== "builtin";
  }

  /** «Смотреть онлайн»: the quality to request for an online variant (null = the server's default). */
  preferQuality(releaseId: string, quality: number | null) {
    if (quality === null) this.onlineQuality.delete(releaseId);
    else this.onlineQuality.set(releaseId, quality);
  }

  /** Plays a release chosen outside the picker (Details' auto-selected source / sources table). */
  playChosen(ctx: PlayContext, release: Release, startAt = ctx.start_at ?? 0, mem?: RouteMemory) {
    if (mem) this.mem = mem;
    this.playRelease(ctx, release, startAt);
  }

  /** Plays a chosen release (`choice` = "Play with…" override). */
  playRelease(ctx: PlayContext, release: Release, startAt = ctx.start_at ?? 0, choice?: PlayerChoice) {
    this.autoResume = false;
    const f = this.flow;
    const auto = f.phase === "picker" ? false : f.phase === "choose" ? f.auto : true;
    const c = this.choiceFor(ctx, choice);
    if (c === "ask") return this.ask(ctx, release, auto, (ch) => this.playRelease(ctx, release, startAt, ch));
    const gen = ++this.gen;
    const full = this.withChoice(ctx, c);
    this.dispatch({ type: "start", ctx: full, release, startAt, auto });
    void this.prepare(gen, full, release);
  }

  /** Plays the best release without the picker (Play key / remote / next episode). */
  playBest(ctx: PlayContext, startAt = ctx.start_at ?? 0, mem?: RouteMemory, choice?: PlayerChoice) {
    this.autoResume = false;
    if (mem) this.mem = mem;
    const c = this.choiceFor(ctx, choice);
    if (c === "ask") return this.ask(ctx, null, true, (ch) => this.playBest(ctx, startAt, undefined, ch));
    const gen = ++this.gen;
    this.dispatch({ type: "start", ctx: this.withChoice(ctx, c), release: null, startAt, auto: true });
    void this.searchAndPlay(gen);
  }

  /**
   * «Продолжить»: the source this item was last watched with, at `startAt`.
   * Gone / failed / another title or episode → the best release instead.
   */
  playSource(ctx: PlayContext, sourceId: string, startAt = ctx.start_at ?? 0, mem?: RouteMemory, choice?: PlayerChoice) {
    this.autoResume = false;
    if (mem) this.mem = mem;
    const c = this.choiceFor(ctx, choice);
    if (c === "ask") return this.ask(ctx, null, true, (ch) => this.playSource(ctx, sourceId, startAt, undefined, ch));
    const gen = ++this.gen;
    const full = this.withChoice(ctx, c);
    this.dispatch({ type: "start", ctx: full, release: null, startAt, auto: true, step: "preparing" });
    void (async () => {
      const src = await getSource(sourceId).catch(() => null);
      if (gen !== this.gen) return;
      const fits = !!src && src.status !== "error" && src.media_id === ctx.media_id && (src.episode_id ?? null) === (ctx.episode_id ?? null);
      if (!fits) return this.searchAndPlay(gen);
      this.remember(full, src.release.id);
      this.dispatch({ type: "chosen", release: src.release });
      await this.follow(gen, src, () => void this.searchAndPlay(gen));
    })();
  }

  /**
   * media.play from a phone. Synchronous: the flow is in "preparing" when
   * this returns; titles/episodes/sources are resolved in the background.
   */
  playRemote(req: RemotePlay, base: { profile_id: string; lang: "en" | "ru" }, mem?: RouteMemory, choice?: PlayerChoice) {
    this.mem = mem;
    const media = cachedMedia(req.media_id, base.lang);
    const ctx: PlayContext = {
      media_id: req.media_id,
      kind: req.episode_id ? "series" : (media?.kind ?? "movie"),
      title: media?.title ?? "",
      poster_path: media?.poster_path ?? null,
      backdrop_path: media?.backdrop_path ?? null,
      season: null,
      episode: null,
      episode_id: req.episode_id ?? null,
      episode_name: null,
      profile_id: base.profile_id,
      lang: base.lang,
      player: null,
      app: null,
    };
    // Replacing a source that is still loading (the phone sent another
    // release mid-preparation): the server stops loading the old one.
    this.dropLoading(req.source_id);
    const c = this.choiceFor(ctx, choice);
    if (c === "ask") return this.ask(ctx, null, true, (ch) => this.playRemote(req, base, mem, ch));
    // No position from the phone: resume where this profile stopped (the
    // playback session tells us once it starts).
    this.autoResume = req.position_seconds === undefined;
    const gen = ++this.gen;
    this.dispatch({ type: "start", ctx: this.withChoice(ctx, c), release: null, startAt: req.position_seconds ?? 0, auto: true, step: "resolving" });
    void this.resolveRemote(gen, req);
  }

  /** media.select_source: switches to another prepared source, keeping position. */
  selectSource(sourceId: string): boolean {
    this.autoResume = false;
    const ctx = this.ctx();
    if (!ctx) return false;
    const gen = ++this.gen;
    const at = this.position();
    this.dropLoading(sourceId);
    this.dispatch({ type: "start", ctx, release: null, startAt: at, auto: true, step: "preparing" });
    void (async () => {
      try {
        const src = await getSource(sourceId);
        if (gen !== this.gen) return;
        if (src.media_id !== ctx.media_id) return this.dispatch({ type: "fail", code: "release_unavailable" });
        await this.applySourceEpisode(gen, src);
        this.dispatch({ type: "chosen", release: src.release });
        await this.follow(gen, src);
      } catch (e) {
        if (gen === this.gen) this.dispatch({ type: "fail", code: apiErrorCode(e) });
      }
    })();
    return true;
  }

  /** Back inside the flow (preparing/failed → picker, else exits). */
  back() {
    this.cancelLoading();
    this.gen++;
    this.loadSeq++;
    loadTracker.forget();
    this.dispatch({ type: "back" });
  }

  /** Exits to Details, stopping any playback. */
  close() {
    this.cancelLoading();
    this.gen++;
    this.loadSeq++;
    loadTracker.forget();
    this.dispatch({ type: "close" });
  }

  /** Still loading: no picture yet (preparing, or the built-in player before its first frame). */
  loading(): boolean {
    const f = this.flow;
    return f.phase === "preparing" || (f.phase === "playing" && f.ctx.player === "builtin" && !this.started);
  }

  /** Switching to `next` while another source loads: that one is cancelled (not `next` itself). */
  private dropLoading(next: string | null | undefined) {
    const f = this.flow;
    const id = f.phase === "preparing" ? f.source?.id : f.phase === "playing" ? f.source.id : undefined;
    if (id && id !== next) this.cancelLoading();
  }

  /** What the loading screen shows (its progress and live torrent numbers), for the device state. */
  private loadShown: { key: string; p: number; torrent: PlaybackSource["torrent"] | null } | null = null;

  /**
   * The loading screen reports its progress / numbers: phones following a
   * media.play see them in the device state (sent on 5 % steps and new numbers).
   */
  reportLoad(key: string, p: number, torrent: PlaybackSource["torrent"] | null) {
    const prev = this.loadShown?.key === key ? this.loadShown : null;
    this.loadShown = { key, p, torrent };
    if (this.checkDead(key, torrent)) return;
    const step = (x: number) => Math.floor(x * 20);
    if (!prev || step(prev.p) !== step(p) || JSON.stringify(prev.torrent) !== JSON.stringify(torrent)) this.emit("playback");
  }

  /** Since when this load's torrent has had no connected peer and no data. */
  private dead: { key: string; since: number } | null = null;
  /** Automatic switches away from dead torrents for this title (capped). */
  private deadSwitches: { title: string; n: number } = { title: "", n: 0 };

  /**
   * A torrent that never connects to a single peer (all "seeders" unreachable
   * from the server — seen with BigFANGroup) would load forever: after
   * DEAD_TORRENT_MS with no peer and no bytes, try the next release by itself
   * (at most MAX_DEAD_SWITCHES times per title, then the failure screen).
   * Returns true when it switched.
   */
  private checkDead(key: string, t: PlaybackSource["torrent"] | null): boolean {
    const f = this.flow;
    const alive = !t || (t.peers ?? 0) > 0 || (t.download_speed_bps ?? 0) > 0 || (t.preloaded_bytes ?? 0) > 0;
    if (this.started || (f.phase !== "preparing" && f.phase !== "playing") || alive) {
      if (this.dead?.key === key || this.started) this.dead = null;
      return false;
    }
    const now = Date.now();
    if (this.dead?.key !== key) {
      this.dead = { key, since: now };
      return false;
    }
    if (now - this.dead.since < DEAD_TORRENT_MS) return false;
    this.dead = null;
    const title = `${f.ctx.media_id}|${f.ctx.episode_id ?? ""}`;
    if (this.deadSwitches.title !== title) this.deadSwitches = { title, n: 0 };
    this.cancelLoading();
    this.dispatch({ type: "ctx", patch: { start_at: Math.floor(f.startAt) } });
    this.dispatch({ type: "fail", code: "no_peers" });
    if (this.deadSwitches.n >= MAX_DEAD_SWITCHES) return true;
    this.deadSwitches.n++;
    this.tryAnother();
    return true;
  }

  /** PlaybackState.loading: the loading screen (no picture yet) or a mid-playback rebuffer, else null. */
  private loadingState(): PlaybackLoading | null {
    const f = this.flow;
    if (f.phase !== "preparing" && f.phase !== "playing") return null;
    // Another load's numbers (the screen hasn't reported this one yet) don't count.
    const shown = this.loadShown?.key === this.loadKey() ? this.loadShown : null;
    const numbers = (t: PlaybackSource["torrent"] | null | undefined) => ({
      peers: t?.peers ?? null,
      seeders: t?.seeders ?? null,
      download_speed_bps: t?.download_speed_bps ?? null,
      preloaded_bytes: t?.preloaded_bytes ?? null,
    });
    const row = f.release ? releaseRow(f.release, f.ctx.lang) : null;
    const release = row ? [row.resolution, row.chips[0], row.size].filter(Boolean).join(" · ") || null : null;
    if (f.phase === "preparing" || (f.ctx.player === "builtin" && !this.started)) {
      const s0 = f.phase === "preparing" ? stageOf(f.step, f.source) : "starting";
      const stage = s0 === "done" ? "starting" : s0;
      return { stage, progress: Math.round((shown?.p ?? 0) * 100) / 100, release, ...numbers(shown?.torrent ?? f.source?.torrent) };
    }
    const r = this.rebuf ? this.rebuffering() : null;
    if (r) return { stage: "rebuffering", progress: r.pct / 100, release, ...numbers(shown?.torrent ?? f.source.torrent) };
    return null;
  }

  /** Identifies one load attempt (the loading screen's progress restarts only for a new one). */
  loadKey(): string {
    // Title + episode, not the attempt counter or the release: internal
    // restarts (compat switch, reload, re-applied seek) and failing over to
    // another release / source must not send the loading bar back to 0 —
    // it only ever grows until the player is left.
    const f = this.flow;
    if (f.phase !== "preparing" && f.phase !== "playing") return `idle|${this.gen}`;
    return `${f.ctx.media_id}|${f.ctx.episode_id ?? ""}|${this.loadSeq}`;
  }

  /** Leaving while it loads: the server stops loading the source too. */
  private cancelLoading() {
    if (!this.loading()) return;
    const f = this.flow;
    const id = f.phase === "preparing" ? f.source?.id : f.phase === "playing" ? f.source.id : undefined;
    if (id) cancelSource(id);
  }

  /** "Try another release": the next untried release avoiding failed codecs, else the picker. */
  tryAnother() {
    const f = this.flow;
    if (f.phase !== "failed") return;
    const list = cachedReleases(releaseQuery(f.ctx));
    const next = list ? nextRelease(list.items, f.tried, f.avoid, this.probe(), this.rankEnv(f.ctx)) : null;
    if (next) {
      const gen = ++this.gen;
      this.dispatch({ type: "start", ctx: f.ctx, release: next, startAt: f.ctx.start_at ?? 0, auto: f.auto });
      void this.prepare(gen, f.ctx, next);
      return;
    }
    this.choose();
  }

  /** Back to the picker (keeps the failed releases marked). */
  choose() {
    this.gen++;
    this.dispatch({ type: "another" });
  }

  /** The release the "Try another release" button would play. */
  nextCandidate(): Release | null {
    const f = this.flow;
    if (f.phase !== "failed") return null;
    const list = cachedReleases(releaseQuery(f.ctx));
    return list ? nextRelease(list.items, f.tried, f.avoid, this.probe(), this.rankEnv(f.ctx)) : null;
  }

  // ------------------------------------------------------------------ async steps

  private ctx(): PlayContext | null {
    return this.flow.phase === "idle" ? null : this.flow.ctx;
  }

  /** What the TV knows for ranking releases: its last measured rate, compat on the server, the runtime. */
  rankEnv(ctx: PlayContext | null = this.ctx()): RankEnv {
    const media = ctx ? cachedMedia(ctx.media_id, ctx.lang) : undefined;
    const runtime = ctx && ctx.kind !== "series" && media?.runtime ? media.runtime * 60 : null;
    return { probe: this.probe(), rateBps: this.lighterRate ?? rateStore.get() ?? deviceCapRate(), compat: compatServer.get(), runtime, smooth: thisSmoothView() };
  }

  /** A lighter release when the source's release is too heavy for this TV (codecs.ts lighterInstead), else null. */
  private async lighterThan(src: PlaybackSource): Promise<Release | null> {
    const ctx = this.ctx();
    if (!ctx || ctx.player !== "builtin") return null;
    const release = src.release;
    // This source's own compat stream counts (the remembered flag may be unset yet).
    const base = this.rankEnv(ctx);
    const env = { ...base, compat: base.compat || !!compatUrlOf(src) };
    if (!tooHeavyHere(release, env)) return null;
    try {
      const list = await fetchReleases(releaseQuery(ctx));
      const next = lighterInstead(release, list.items, env);
      if (next) console.info("[martytv] source too heavy for this TV, playing a lighter release", { from: release.id, to: next.id, rate: env.rateBps });
      return next;
    } catch {
      return null;
    }
  }

  private remember(ctx: PlayContext, releaseId: string) {
    this.mem?.set(memKey(ctx), releaseId);
  }

  private async resolveRemote(gen: number, req: RemotePlay) {
    try {
      const ctx = this.ctx()!;
      const media = await loadMedia(req.media_id, ctx.lang);
      if (gen !== this.gen) return;
      this.dispatch({
        type: "ctx",
        patch: { title: media.title, kind: media.kind, poster_path: media.poster_path ?? null, backdrop_path: media.backdrop_path ?? null },
      });
      if (req.source_id) {
        const src = await getSource(req.source_id);
        if (gen !== this.gen) return;
        if (src.media_id !== req.media_id) return this.dispatch({ type: "fail", code: "release_unavailable" });
        // The episode the phone named counts when the source doesn't say.
        await this.applySourceEpisode(gen, req.episode_id && !src.episode_id ? { ...src, episode_id: req.episode_id } : src);
        if (gen !== this.gen) return;
        // A source chosen elsewhere (phone, resume) that's too heavy for this
        // TV: the best suitable release instead, same position.
        const swap = await this.lighterThan(src);
        if (gen !== this.gen) return;
        if (swap) {
          const cur = this.ctx()!;
          this.dispatch({ type: "chosen", release: swap });
          return this.prepare(gen, cur, swap);
        }
        this.dispatch({ type: "chosen", release: src.release });
        return this.follow(gen, src);
      }
      if (media.kind === "series") {
        let ep: Episode | null | undefined;
        if (req.episode_id) ep = await findEpisode(req.media_id, req.episode_id, ctx.lang);
        else {
          // No episode given: the first episode of the default season.
          const n = pickSeason(media.seasons, null);
          ep = n === null ? null : (await loadSeason(req.media_id, n, ctx.lang)).episodes[0];
        }
        if (gen !== this.gen) return;
        if (!ep) return this.dispatch({ type: "fail", code: "no_matching_file" });
        this.dispatch({ type: "ctx", patch: { season: ep.season_number, episode: ep.episode_number, episode_id: ep.id, episode_name: ep.name } });
      }
      if (req.release_id) return await this.prepareRelease(gen, req.release_id, req.quality);
      await this.searchAndPlay(gen);
    } catch (e) {
      if (gen === this.gen) this.dispatch({ type: "fail", code: apiErrorCode(e) });
    }
  }

  /**
   * media.play with a release chosen on the phone: the TV creates the source
   * itself (the loading screen shows from the start). A release too heavy for
   * this TV is swapped for a lighter one, like a source prepared elsewhere.
   */
  private async prepareRelease(gen: number, releaseId: string, quality?: number) {
    const ctx = this.ctx();
    if (!ctx || gen !== this.gen) return;
    this.dispatch({ type: "step", step: "preparing" });
    if (quality !== undefined) this.onlineQuality.set(releaseId, quality);
    this.remember(ctx, releaseId);
    const src = await createSource({
      media_id: ctx.media_id,
      release_id: releaseId,
      profile_id: ctx.profile_id,
      ...(ctx.episode_id ? { episode_id: ctx.episode_id } : {}),
      ...(quality !== undefined ? { quality } : {}),
    });
    if (gen !== this.gen) return cancelSource(src.id);
    const swap = src.status === "error" ? null : await this.lighterThan(src);
    if (gen !== this.gen) return cancelSource(src.id);
    if (swap) {
      cancelSource(src.id);
      this.dispatch({ type: "chosen", release: swap });
      return this.prepare(gen, this.ctx()!, swap);
    }
    this.dispatch({ type: "chosen", release: src.release });
    // A failure shows on the TV (with «Другая раздача») and reaches the phone as player_error.
    await this.follow(gen, src);
  }

  /** A source prepared elsewhere (phone): learn its episode for the label. */
  private async applySourceEpisode(gen: number, src: PlaybackSource) {
    const ctx = this.ctx();
    if (!ctx || !src.episode_id || !src.media_id || (ctx.episode_id === src.episode_id && ctx.season !== null)) return;
    const ep = await findEpisode(src.media_id, src.episode_id, ctx.lang).catch(() => null);
    if (gen !== this.gen) return;
    this.dispatch({
      type: "ctx",
      patch: ep
        ? { kind: "series", season: ep.season_number, episode: ep.episode_number, episode_id: ep.id, episode_name: ep.name }
        : { kind: "series", episode_id: src.episode_id },
    });
  }

  private async searchAndPlay(gen: number) {
    this.dispatch({ type: "step", step: "searching" });
    try {
      const f = this.flow;
      if (f.phase !== "preparing") return;
      const list = await fetchReleases(releaseQuery(f.ctx));
      if (gen !== this.gen) return;
      const cur = this.flow;
      if (cur.phase !== "preparing") return;
      const r = nextRelease(list.items, cur.tried, cur.avoid, this.probe(), this.rankEnv(cur.ctx));
      if (!r) return this.dispatch({ type: "fail", code: "no_releases" });
      this.dispatch({ type: "chosen", release: r });
      await this.prepare(gen, cur.ctx, r);
    } catch (e) {
      if (gen === this.gen) this.dispatch({ type: "fail", code: apiErrorCode(e) });
    }
  }

  private async prepare(gen: number, ctx: PlayContext, release: Release, fallback?: () => void) {
    this.remember(ctx, release.id);
    let src: PlaybackSource;
    try {
      src = await createSource({
        media_id: ctx.media_id,
        release_id: release.id,
        profile_id: ctx.profile_id,
        ...(ctx.episode_id ? { episode_id: ctx.episode_id } : {}),
        ...(this.onlineQuality.has(release.id) ? { quality: this.onlineQuality.get(release.id)! } : {}),
      });
    } catch (e) {
      if (gen !== this.gen) return;
      if (fallback) return fallback();
      return this.dispatch({ type: "fail", code: apiErrorCode(e) });
    }
    // Cancelled while the server was creating it: stop it there too.
    if (gen !== this.gen) return cancelSource(src.id);
    await this.follow(gen, src, fallback);
  }

  /** Polls a source until ready/error, publishing its live stats. */
  private async follow(gen: number, first: PlaybackSource, fallback?: () => void) {
    const t0 = this.now();
    let src = first;
    let errors = 0;
    for (;;) {
      if (gen !== this.gen) return;
      if (src.status === "error" && fallback) return fallback();
      if (src.status === "ready" && !src.stream_url) return this.dispatch({ type: "fail", code: "generic" });
      this.dispatch({ type: "source", source: src });
      if (src.status !== "preparing") return;
      if (this.now() - t0 > PREPARE_TIMEOUT) return this.dispatch({ type: "fail", code: "timeout" });
      await sleep(POLL_MS);
      if (gen !== this.gen) return;
      try {
        src = await getSource(src.id);
        errors = 0;
      } catch (e) {
        if (++errors >= 4) {
          if (gen === this.gen) this.dispatch({ type: "fail", code: apiErrorCode(e) });
          return;
        }
      }
    }
  }

  // ------------------------------------------------------------------ next episode

  /** The episode after the current one, from cached catalog data. */
  nextRef(): EpisodeRef | null {
    const ctx = this.ctx();
    if (!ctx || ctx.kind !== "series" || ctx.season === null || ctx.episode === null) return null;
    const media = cachedMedia(ctx.media_id, ctx.lang);
    const cur = cachedSeason(ctx.media_id, ctx.season, ctx.lang);
    const seasons = media?.seasons ?? [];
    const later = seasons.filter((s) => s.season_number > ctx.season!).sort((a, b) => a.season_number - b.season_number)[0];
    const nextList = later ? cachedSeason(ctx.media_id, later.season_number, ctx.lang)?.episodes : undefined;
    if (!cur && !media) return { season: ctx.season, episode: ctx.episode + 1 };
    return resolveNext({ season: ctx.season, episode: ctx.episode }, cur?.episodes, seasons, nextList);
  }

  /** The episode before the current one, from cached catalog data. */
  prevRef(): EpisodeRef | null {
    const ctx = this.ctx();
    if (!ctx || ctx.kind !== "series" || ctx.season === null || ctx.episode === null) return null;
    const media = cachedMedia(ctx.media_id, ctx.lang);
    const cur = cachedSeason(ctx.media_id, ctx.season, ctx.lang);
    const seasons = media?.seasons ?? [];
    const earlier = seasons
      .filter((s) => s.season_number > 0 && s.season_number < ctx.season!)
      .sort((a, b) => b.season_number - a.season_number)[0];
    const prevList = earlier ? cachedSeason(ctx.media_id, earlier.season_number, ctx.lang)?.episodes : undefined;
    return resolvePrev({ season: ctx.season, episode: ctx.episode }, cur?.episodes, seasons, prevList);
  }

  /** Starts the next episode (see goEpisode). False if there's none. */
  nextEpisode(): boolean {
    return this.goEpisode(this.nextRef());
  }

  /** Starts the previous episode (overlay «Предыдущая серия», ⏮). False if there's none. */
  prevEpisode(): boolean {
    return this.goEpisode(this.prevRef());
  }

  /**
   * Starts another episode: the same season pack when it covers it (a new
   * source with the same release), else a new search.
   */
  private goEpisode(ref: EpisodeRef | null): boolean {
    this.autoResume = false;
    const f = this.flow;
    if (f.phase === "idle" || f.phase === "picker") return false;
    if (!ref) return false;
    const prevRelease = f.release;
    const gen = ++this.gen;
    const ctx: PlayContext = { ...f.ctx, season: ref.season, episode: ref.episode, episode_id: ref.id ?? null, episode_name: ref.name ?? null, start_at: 0 };
    this.dispatch({ type: "start", ctx, release: null, startAt: 0, auto: true, step: "resolving" });
    void (async () => {
      try {
        if (!ref.id) {
          const season = await loadSeason(ctx.media_id, ref.season, ctx.lang);
          if (gen !== this.gen) return;
          const ep = season.episodes.find((e) => e.episode_number === ref.episode) ?? null;
          if (!ep) return this.dispatch({ type: "fail", code: "no_matching_file" });
          this.dispatch({ type: "ctx", patch: { episode_id: ep.id, episode_name: ep.name } });
        }
        const cur = this.ctx()!;
        if (prevRelease && packCovers(prevRelease, ref.season, ref.episode)) {
          this.dispatch({ type: "chosen", release: prevRelease });
          return this.prepare(gen, cur, prevRelease, () => void this.searchAndPlay(gen));
        }
        await this.searchAndPlay(gen);
      } catch (e) {
        if (gen === this.gen) this.dispatch({ type: "fail", code: apiErrorCode(e) });
      }
    })();
    return true;
  }

  // ------------------------------------------------------------------ the <video>

  attach(v: HTMLVideoElement) {
    if (this.video === v) return;
    // Only a previous <video> is detached. The flow can reach "playing" (and
    // open the progress session) before the player view mounts — the player
    // chunk loads lazily, a phone's media.play with a ready source is fast —
    // and detach() would end that fresh session: no progress reports at all.
    if (this.video) this.detach();
    this.video = v;
    const emit = () => this.emit("playback");
    const events = ["play", "pause", "playing", "waiting", "seeked", "ended", "volumechange", "durationchange", "canplay", "loadedmetadata"];
    // The start / pending seek goes in once the engine knows the duration —
    // at loadedmetadata, or later (some engines report NaN there: the seek
    // used to stay pending forever, the bar showing a spot the video never
    // went to). Engines that drop an early seek get it once more when they
    // start playing elsewhere.
    const onMeta = () => {
      const at = this.pendingSeek;
      if (at === null || !(v.duration > 0)) return;
      const target = Math.min(at, isFinite(v.duration) ? Math.max(0, v.duration - 3) : at);
      this.pendingSeek = null;
      this.seekCheck = { target, retried: false };
      try {
        v.currentTime = target;
      } catch {
        // not seekable yet: the check below retries
      }
    };
    const onCheck = () => {
      const c = this.seekCheck;
      if (!c || v.seeking || this.compat || this.compatPending !== null) return;
      if (!seekMissed(v.currentTime, c.target)) {
        this.seekCheck = null;
        return;
      }
      if (c.retried) {
        this.seekCheck = null;
        return;
      }
      c.retried = true;
      this.seekAllowedUntil = Date.now() + 8000;
      try {
        v.currentTime = c.target;
      } catch {
        this.seekCheck = null;
      }
    };
    const onError = () => this.onVideoError();
    const onTime = () => this.onTime();
    // Progress reports and the first-frame flag.
    const onReport = (e: Event) => {
      if (this.loadedUrl === null) return;
      switch (e.type) {
        case "loadedmetadata":
          if (!this.metadata) {
            this.metadata = true;
            this.applyPreferredAudio();
            this.emit("progress");
          }
          return;
        case "canplay":
        case "playing":
          if (!this.started) {
            this.started = true;
            this.emit("progress");
          }
          if (e.type === "playing") this.reporter.report("playing");
          return;
        case "pause":
          // Our own pause while rebuffering is not reported (still "playing").
          if (!v.ended && !this.rebuf) this.reporter.report("paused");
          return;
        case "seeked":
          this.reporter.seeked();
          return;
        case "ended":
          if (this.endedForReal()) this.reporter.report("ended");
          else this.recoverPrematureEnd();
          return;
      }
    };
    const reportEvents = ["loadedmetadata", "canplay", "playing", "pause", "seeked", "ended"];
    // A stall after playback started: pause and rebuffer to a threshold
    // instead of resuming on every sliver of data.
    const onWaiting = () => this.onStall();
    const onThrough = () => {
      if (this.rebuf) this.rebuf.canPlayThrough = true;
    };
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("canplaythrough", onThrough);
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this.tick(), 500);
    // The held frame goes once the new stream shows its own: playing, or
    // (paused) its first frame at the right spot; on errors too.
    const onFrame = (e: Event) => {
      if (e.type === "playing" || e.type === "error" || (v.paused && this.pendingSeek === null && !v.seeking && v.readyState >= 2)) this.releaseFrame();
    };
    const metaEvents = ["loadedmetadata", "durationchange", "canplay"];
    const checkEvents = ["playing", "timeupdate"];
    const frameEvents = ["playing", "loadeddata", "seeked", "canplay", "error"];
    metaEvents.forEach((e) => v.addEventListener(e, onMeta));
    checkEvents.forEach((e) => v.addEventListener(e, onCheck));
    frameEvents.forEach((e) => v.addEventListener(e, onFrame));
    v.addEventListener("error", onError);
    v.addEventListener("timeupdate", onTime);
    events.forEach((e) => v.addEventListener(e, emit));
    reportEvents.forEach((e) => v.addEventListener(e, onReport));
    // The TV's saved level (playback.set_volume) applies to every new film.
    const unbindVolume = tvVolume.bind(v);
    this.detachVideo = () => {
      unbindVolume();
      clearInterval(this.tickTimer);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("canplaythrough", onThrough);
      metaEvents.forEach((e) => v.removeEventListener(e, onMeta));
      checkEvents.forEach((e) => v.removeEventListener(e, onCheck));
      frameEvents.forEach((e) => v.removeEventListener(e, onFrame));
      this.releaseFrame();
      v.removeEventListener("error", onError);
      v.removeEventListener("timeupdate", onTime);
      events.forEach((e) => v.removeEventListener(e, emit));
      reportEvents.forEach((e) => v.removeEventListener(e, onReport));
    };
    const f = this.flow;
    if (f.phase === "playing" && f.source.stream_url) {
      // A new view of the same playback (the old one's detach ended its session): report again.
      if (!this.reporter.active) this.beginSession(f.ctx, f.source);
      this.loadSource(f.source, f.startAt);
    }
  }

  /**
   * The first load of a source: compat audio when this TV needs it, else the
   * original stream. Without media_info the audio codec is unknown: wait for
   * it first (a short while) when a compat stream could be needed.
   */
  private loadSource(src: PlaybackSource, at: number) {
    if (this.needsInfo(src)) return this.awaitInfo(src, at);
    this.loadDecided(src, at);
  }

  private loadDecided(src: PlaybackSource, at: number) {
    if (this.shouldCompat(src, false)) void this.startCompat(at, true, null);
    else if (src.stream_url) this.load(src.stream_url, at, true);
  }

  /**
   * The compat decision can't be made yet: a torrent with a compat stream on
   * an engine that plays it, «auto», no media_info, and the release's parsed
   * codecs didn't already say «undecodable».
   */
  private needsInfo(src: PlaybackSource): boolean {
    return compatPlan(src, this.probe(), this.compatPref()) === "wait_info";
  }

  /**
   * Polls GET /playback/sources/{id} (which also starts the server's ffprobe)
   * until media_info arrives. Within INFO_WAIT_MS nothing is loaded, then the
   * decided stream starts from the first frame; later, the original plays
   * and switches to compat at the current spot once the info says so.
   */
  private awaitInfo(src: PlaybackSource, at: number) {
    const cur = this.infoWait;
    if (cur && cur.gen === this.gen && cur.id === src.id) {
      // The video element (re)attached: past the wait, load now; else keep waiting.
      if (cur.loaded) this.loadDecided(src, at);
      else cur.at = at;
      return;
    }
    const gen = this.gen;
    const w = { gen, id: src.id, at, loaded: false };
    this.infoWait = w;
    const t0 = this.now();
    const alive = () => this.infoWait === w && gen === this.gen && this.flow.phase === "playing" && this.flow.source.id === w.id;
    const firstLoad = (s: PlaybackSource) => {
      w.loaded = true;
      if (this.video) this.loadDecided(s, w.at);
    };
    void (async () => {
      for (;;) {
        const waited = this.now() - t0;
        if (!w.loaded && waited >= INFO_WAIT_MS) firstLoad((this.flow as Extract<Flow, { phase: "playing" }>).source);
        if (waited >= INFO_GIVE_UP_MS) break;
        await sleep(w.loaded ? INFO_BG_POLL_MS : INFO_POLL_MS);
        if (!alive()) return;
        let fresh: PlaybackSource;
        try {
          fresh = await getSource(w.id);
        } catch {
          continue;
        }
        if (!alive()) return;
        if (fresh.status !== "ready" || !fresh.media_info) continue;
        this.dispatch({ type: "source", source: fresh });
        this.support = assessSource(fresh, this.probe());
        if (!w.loaded) firstLoad(fresh);
        else if (this.video && !this.compat && this.compatPending === null && this.shouldCompat(fresh, false)) {
          void this.startCompat(this.trustedPosition(), !this.video.paused || !!this.rebuf, null);
        }
        this.emit("playback");
        break;
      }
      if (this.infoWait === w) this.infoWait = null;
    })();
  }

  /** Waiting for media_info before the first load (nothing is loaded yet). */
  awaitingInfo(): boolean {
    const w = this.infoWait;
    return !!w && !w.loaded && w.gen === this.gen;
  }

  /** Stops and frees the stream connection (removing src closes it). */
  detach() {
    // The player view goes away (e.g. the app leaves the signed-in area).
    if (this.flow.phase === "playing") this.endSession();
    this.dropHls();
    const v = this.video;
    this.detachVideo?.();
    this.detachVideo = null;
    this.video = null;
    this.loadedUrl = null;
    if (!v) return;
    try {
      v.pause();
      v.removeAttribute("src");
      v.load();
    } catch {
      // ignore
    }
  }

  private onPlaying(src: PlaybackSource) {
    this.resumeAt = null;
    this.recoveries = 0;
    const f0 = this.flow;
    this.started = false;
    this.metadata = false;
    this.lastSnap = null;
    if (f0.phase === "playing") this.beginSession(f0.ctx, src);
    if (f0.phase === "playing" && f0.ctx.player !== "builtin") return this.handOff(f0.ctx, src, f0.startAt);
    this.support = assessSource(src, this.probe());
    this.refreshes = 0;
    this.audioChecked = false;
    this.freshUrl = null;
    this.compat = null;
    this.compatPending = null;
    this.compatTried = false;
    this.compatVideoForced = false;
    this.infoWait = null;
    this.lighterRate = null;
    this.resetBandwidth();
    compatServer.note(src);
    this.scheduleRefresh(src);
    const f = this.flow;
    if (this.video && f.phase === "playing" && src.stream_url) this.loadSource(src, f.startAt);
    // Episode list for the label and "next episode".
    const ctx = f.phase === "playing" ? f.ctx : null;
    if (ctx?.kind === "series" && ctx.season !== null) {
      void loadMedia(ctx.media_id, ctx.lang).catch(() => undefined);
      void loadSeason(ctx.media_id, ctx.season, ctx.lang).catch(() => undefined);
    }
  }

  /**
   * Opens a playback session. MSX / external players get one too (the
   * server learns what is being watched) but can't report positions.
   */
  private beginSession(ctx: PlayContext, src: PlaybackSource) {
    const builtin = ctx.player === "builtin";
    const resume = this.autoResume;
    this.autoResume = false;
    const gen = this.gen;
    const seeksAtBegin = this.seeks;
    void this.reporter
      .begin(
        { profile_id: ctx.profile_id, media_id: ctx.media_id, episode_id: ctx.episode_id ?? src.episode_id, source_id: src.id },
        () => this.snapshot(),
        builtin,
      )
      .then((r) => {
        // media.play without a position: resume where this profile stopped —
        // unless the viewer already seeked somewhere (a late answer must not
        // pull them back). Absolute position: a compat stream's own
        // currentTime starts at 0 wherever it is in the film.
        const at = r?.resume_position_seconds;
        if (!resume || !builtin || gen !== this.gen || at === null || at === undefined || at < MIN_RESUME) return;
        if (this.seeks !== seeksAtBegin) return;
        if (this.awaitingInfo()) {
          this.infoWait!.at = at;
          return;
        }
        const v = this.video;
        if (v && !v.seeking && this.position() < 5) this.seekTo(at);
        else if (!v) this.pendingSeek = at;
      });
  }

  /**
   * Selects the profile's preferred voice-over / audio language once per
   * source. Only where the engine exposes video.audioTracks (else nothing).
   */
  private applyPreferredAudio() {
    const f = this.flow;
    const v = this.video;
    const list = (v as unknown as { audioTracks?: EngineList<EngineAudioTrack> } | null)?.audioTracks;
    if (f.phase !== "playing" || !list || list.length < 2) return;
    const info = f.source.media_info;
    const gen = this.gen;
    void loadPreferences(f.ctx.profile_id)
      .then((prefs) => {
        if (!prefs || gen !== this.gen || this.video !== v) return;
        const cands = [];
        for (let i = 0; i < list.length; i++) {
          const t = list[i]!;
          const meta = info?.audio[i];
          cands.push({ label: [t.label, meta?.title].filter(Boolean).join(" "), language: t.language || meta?.language || null });
        }
        const at = pickPreferredAudio(cands, { voiceovers: prefs.preferred_voiceovers, languages: prefs.preferred_audio_languages });
        if (at === null || list[at]!.enabled) return;
        this.setAudio(`a${at}`);
      })
      .catch(() => undefined);
  }

  /** Final report of the current session; Home / Details refresh their progress. */
  private endSession() {
    this.recordRate();
    // A long clean session of a variant noted as rough: it plays fine here after all.
    const fs = this.flow;
    if (fs.phase === "playing" && provenSmooth(this.frames) && !this.stutterSeen) {
      const token = sourceSmoothToken(fs.source);
      if (token) clearStutter(token);
    }
    if (!this.reporter.active) return;
    const snap = this.snapshot() ?? this.lastSnap;
    this.reporter.end(snap);
    const f = this.flow;
    if (snap && f.phase === "playing" && f.ctx.player === "builtin") {
      const kind = f.ctx.kind === "series" || f.ctx.episode_id ? "series" : "movie";
      if (isCompleted(snap.position, snap.duration, kind)) {
        const media = cachedMedia(f.ctx.media_id, f.ctx.lang);
        ratingQueue.offer(
          { profile_id: f.ctx.profile_id, media_id: f.ctx.media_id, episode_id: f.ctx.episode_id, kind, title: f.ctx.title, poster_path: f.ctx.poster_path },
          media?.me?.rating !== null && media?.me?.rating !== undefined,
        );
      }
    }
    // Give the server a moment to store the last report.
    setTimeout(() => refreshWatchData(), 600);
  }

  /** Page hidden / unloading: report the position with a keepalive request. */
  pageHidden() {
    if (this.flow.phase === "playing") this.reporter.hidden();
  }

  /** Sends the stream to MSX's player or an external Android app. */
  private handOff(ctx: PlayContext, src: PlaybackSource, startAt: number) {
    const url = absoluteStreamUrl(src, location.origin);
    if (!url) return this.dispatch({ type: "fail", code: "generic" });
    const title = [ctx.title, episodeLabel(ctx.season, ctx.episode, ctx.episode_name)].filter(Boolean).join(" — ");
    const gen = this.gen;
    if (ctx.player === "external") {
      // Inside MSX: its documented system:tvx:launch action via the bridge
      // (the WebView rejects intent://). In Chrome on Android: intent://.
      const route = externalRoute(currentEnv());
      if (route === "msx") {
        void launchOnMsx({ url, title, position_seconds: Math.floor(startAt), app: ctx.app ?? "system" }, (code) => {
          // -2: the app couldn't be launched, -3: MSX internal error.
          if (gen === this.gen && code !== null && code <= -2) this.dispatch({ type: "fail", code: "external_failed" });
        }).then((ack) => {
          if (gen === this.gen && !ack.ok) this.dispatch({ type: "fail", code: "external_failed" });
        });
        return;
      }
      if (route !== "intent") return this.dispatch({ type: "fail", code: "external_failed" });
      try {
        location.href = intentUrl(url, title, src.mime_type, ctx.app ?? "system");
      } catch {
        this.dispatch({ type: "fail", code: "external_failed" });
      }
      return;
    }
    void playOnMsx({ url, title, position_seconds: Math.floor(startAt) }).then((ack) => {
      if (gen !== this.gen || ack.ok) return;
      this.dispatch({ type: "fail", code: "msx_failed" });
    });
  }

  private unload() {
    clearTimeout(this.expiryTimer);
    this.dropHls();
    this.support = null;
    this.compat = null;
    this.compatPending = null;
    this.compatSeq++;
    this.rebuf = null;
    this.freshUrl = null;
    this.releaseFrame();
    const v = this.video;
    this.loadedUrl = null;
    if (!v) return;
    try {
      v.pause();
      v.removeAttribute("src");
      v.load();
    } catch {
      // ignore
    }
  }

  private load(url: string, at: number, play: boolean, compat = false) {
    const v = this.video;
    if (!v) return;
    // A new stream mid-film (compat seek / track switch, refreshed URL,
    // recovery): swapping src blanks the element until the new stream has
    // a frame — keep the last picture up meanwhile.
    if (this.started && this.loadedUrl !== null) this.holdFrame(v);
    this.dropHls();
    this.loadedUrl = url;
    this.freshUrl = null;
    // Compat streams start at their offset (no Range: nothing to seek to).
    if (!compat) {
      this.compat = null;
      this.compatPending = null;
      this.compatSeq++;
    }
    this.pendingSeek = !compat && at > 0.5 ? at : null;
    this.seekCheck = null;
    this.lastGood = at;
    this.loadedAt = at;
    this.seekAllowedUntil = Date.now() + 15000;
    // A fresh stream: the next stall uses the short after-seek threshold.
    this.rebuf = null;
    this.stallAt = null;
    this.seekedAt = Date.now();
    this.rateSamples = [];
    const f = this.flow;
    // Online HLS on Android: hls.js (its native HLS seeks badly), see stream.ts.
    const mode = compat ? "native" : streamMode(f.phase === "playing" ? f.source : null, v, undefined, isAndroid());
    if (mode === "none") {
      // Neither native HLS nor MSE: report it once this dispatch has finished.
      setTimeout(() => this.flow.phase === "playing" && this.dispatch({ type: "unplayable", reason: "HLS", avoid: [] }), 0);
      return;
    }
    if (mode === "hlsjs") {
      try {
        v.removeAttribute("src");
      } catch {
        // ignore
      }
      const seq = this.hlsSeq;
      attachHlsJs(v, url, (kind) => this.onHlsFatal(kind), at).then(
        (h) => {
          if (seq !== this.hlsSeq || this.video !== v) return h.destroy();
          this.hls = h;
          if (play) this.play();
        },
        () => {
          if (seq === this.hlsSeq && this.flow.phase === "playing") this.dispatch({ type: "unplayable", reason: "HLS", avoid: [] });
        },
      );
      return;
    }
    v.src = url;
    v.load();
    if (play) this.play();
  }

  /** The player view's canvas for the held frame (PlayerLayer). */
  attachFrame(c: HTMLCanvasElement | null) {
    this.frameCanvas = c;
    if (!c) this.frameHeld = false;
  }

  /** The last frame is shown over the (reloading) video. */
  frameShown(): boolean {
    return this.frameHeld;
  }

  /** Copies the current picture to the frame canvas (best effort: engines with a hardware video plane may give nothing). */
  private holdFrame(v: HTMLVideoElement) {
    const c = this.frameCanvas;
    if (!c || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return;
    try {
      // ≤ 1280 px wide: a weak box shouldn't spend memory on a full-HD still.
      const scale = Math.min(1, 1280 / v.videoWidth);
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      const g = c.getContext("2d");
      if (!g) return;
      g.drawImage(v, 0, 0, c.width, c.height);
      this.frameHeld = true;
      this.emit("playback");
    } catch {
      this.frameHeld = false;
    }
  }

  /** The new stream shows a picture (or nothing will): drop the held frame. */
  private releaseFrame() {
    if (!this.frameHeld) return;
    this.frameHeld = false;
    const c = this.frameCanvas;
    if (c) {
      // Free the bitmap.
      c.width = 1;
      c.height = 1;
    }
    this.emit("playback");
  }

  /** Stops hls.js (a pending attach is ignored when it lands). */
  private dropHls() {
    this.hlsSeq++;
    const h = this.hls;
    this.hls = null;
    try {
      h?.destroy();
    } catch {
      // ignore
    }
  }

  /** hls.js gave up: like a <video> error (fresh URL for network drops). */
  private onHlsFatal(kind: "network" | "decode") {
    const f = this.flow;
    if (f.phase !== "playing") return;
    if (kind === "network" && this.refreshes < 3) {
      this.refreshes++;
      this.pendingSeek = null;
      void this.refreshUrl(true);
      return;
    }
    if (kind === "network") return this.dispatch({ type: "fail", code: "network" });
    this.dispatch({ type: "unplayable", reason: "HLS", avoid: [] });
  }

  private play() {
    const p = this.video?.play();
    // Autoplay can be refused (no user gesture): stay paused, OK resumes.
    if (p && typeof p.catch === "function") p.catch(() => this.emit("playback"));
  }

  private scheduleRefresh(src: PlaybackSource) {
    clearTimeout(this.expiryTimer);
    if (!src.stream_expires_at) return;
    const at = Date.parse(src.stream_expires_at);
    if (!isFinite(at)) return;
    const delay = Math.max(5_000, at - this.now() - EXPIRY_MARGIN);
    this.expiryTimer = setTimeout(() => void this.refreshUrl(false), delay);
  }

  /**
   * Gets a fresh stream URL. Swapped in right away when `now` (after an
   * error) or while paused; otherwise on the next seek, which reloads anyway.
   */
  private async refreshUrl(now: boolean) {
    const f = this.flow;
    if (f.phase !== "playing") return;
    const gen = this.gen;
    try {
      // After an error, ride out short outages (an API restart, Wi-Fi blip).
      let src: PlaybackSource | null = null;
      for (let attempt = 0; ; attempt++) {
        try {
          src = await getSource(f.source.id);
          break;
        } catch (e) {
          if (!now || attempt >= REFRESH_RETRIES || gen !== this.gen) throw e;
          await sleep(REFRESH_BACKOFF * (attempt + 1));
        }
      }
      if (gen !== this.gen || this.flow.phase !== "playing") return;
      if (src.status !== "ready" || !src.stream_url) return this.dispatch({ type: "fail", code: src.error || "release_unavailable" });
      this.dispatch({ type: "source", source: src });
      this.scheduleRefresh(src);
      const v = this.video;
      const at = this.resumeAt ?? this.position();
      // Compat: restarts read the fresh compat_url from the flow anyway.
      if (this.compat) {
        if (now) void this.startCompat(at, true, this.compat.audio);
        return;
      }
      if (now || (v && v.paused)) this.load(src.stream_url, at, now ? true : false);
      else this.freshUrl = src.stream_url;
    } catch (e) {
      if (now && gen === this.gen) this.dispatch({ type: "fail", code: apiErrorCode(e) });
    }
  }

  private onTime() {
    const v = this.video;
    const f = this.flow;
    if (!v || f.phase !== "playing" || this.compatPending !== null) return;
    // Absolute time (compat streams count from their offset).
    const t = this.abs(v);
    const allowed = Date.now() <= this.seekAllowedUntil;
    if (!v.seeking && (isUnexplainedJump(t, this.lastGood, allowed) || (!v.ended && isUnexplainedDrop(t, this.lastGood, allowed)))) {
      // Nobody asked for this jump: a broken stream made the engine skip
      // ahead, or restart from the beginning — continue at the trusted spot.
      this.recoverPrematureEnd();
      return;
    }
    if (t > this.lastGood + 2) {
      this.lastGood = t;
      this.refreshes = 0;
      if (this.resumeAt !== null && t >= this.resumeAt - 2) this.resumeAt = null;
      if (this.recoveries > 0 && t > this.recoverFrom + 60) this.recoveries = 0;
    }
    // Needs media_info (whether the file has audio at all): until the
    // background poll brings it, the check waits instead of being used up.
    if (!this.audioChecked && t - this.loadedAt >= AUDIO_CHECK_AFTER && f.source.media_info) {
      this.audioChecked = true;
      const info = f.source.media_info;
      if (info.audio.length > 0 && !hasAudio(v)) {
        // No sound: the server's AAC conversion fixes it (once, if available).
        if (!this.compat && this.shouldCompat(f.source, true)) {
          this.audioChecked = false;
          void this.startCompat(this.trustedPosition(), true, null);
          return;
        }
        const main = info.audio.find((a) => a.default) ?? info.audio[0]!;
        const label = this.support?.parts.find((p) => p.kind === "audio")?.label ?? main.codec.toUpperCase();
        this.dispatch({ type: "unplayable", reason: label, avoid: [main.codec.toLowerCase()], code: "no_audio" });
      }
    }
  }

  private onVideoError() {
    const v = this.video;
    const f = this.flow;
    const err = v?.error;
    if (!v || !err || err.code === 1 || f.phase !== "playing") return;
    // 403 (expired token) and network drops: fresh URL, same position. A 403
    // on the first request surfaces as SRC_NOT_SUPPORTED in Chrome, so that
    // gets one refresh too before it counts as "unplayable".
    // The original file won't decode / open here (MKV, AC3…): the compat
    // stream (fMP4, AAC) may — try it once before giving up. Not when the
    // video itself is known undecodable (10-bit H.264…) and the server
    // can't convert it: compat copies it. Old codecs the server converts
    // (compat_video: XviD, MPEG-2…) are re-encoded on such an error even when
    // the probe claimed support, also when a copied-video compat stream failed.
    const decodeErr = err.code === 3 || err.code === 4;
    const convertible = !!f.source.compat_video;
    if (!this.compat && decodeErr && !this.compatTried && this.compatPossible(f.source) && (convertible || !videoUndecodable(this.support))) {
      this.compatTried = true;
      this.compatVideoForced = convertible;
      void this.startCompat(this.trustedPosition(), true, null);
      return;
    }
    if (decodeErr && convertible && !this.compatVideoForced && !this.compat?.video && this.compatPossible(f.source)) {
      this.compatTried = this.compatVideoForced = true;
      void this.startCompat(this.trustedPosition(), true, this.compat?.audio ?? null);
      return;
    }
    const limit = err.code === 2 ? 3 : err.code === 4 ? (this.compat ? 2 : 1) : 0;
    if (this.refreshes < limit) {
      this.refreshes++;
      this.pendingSeek = null;
      void this.refreshUrl(true);
      return;
    }
    if (err.code === 2) return this.dispatch({ type: "fail", code: "network" });
    // In compat mode only the (copied) video can be at fault: its key goes to
    // `avoid` so «Другая раздача» skips e.g. other 10-bit H.264 releases.
    const { reason, avoid } = decodeFailure(this.support, !!this.compat, f.source.mime_type);
    this.dispatch({ type: "unplayable", reason, avoid });
  }

  /** For error reports: the playing source, original vs compat, codecs and the engine's answers (no URLs). */
  mediaContext(): Record<string, unknown> | undefined {
    const f = this.flow;
    if (f.phase !== "playing" && f.phase !== "preparing") return undefined;
    const src = f.phase === "playing" ? f.source : null;
    const info = src?.media_info ?? null;
    const main = info ? (info.audio.find((a) => a.default) ?? info.audio[0] ?? null) : null;
    return {
      phase: f.phase,
      mode: this.compat ? (this.compat.video ? "compat_video" : "compat") : "original",
      compat_video: f.phase === "playing" ? !!f.source.compat_video : null,
      compat_pref: this.compatPref(),
      compat_tried: this.compatTried,
      source_id: src?.id ?? null,
      kind: src?.kind ?? null,
      container: info?.container ?? null,
      video_codec: info?.video_codec ?? null,
      video_profile: info?.video_profile ?? null,
      pix_fmt: info?.pix_fmt ?? null,
      bit_depth: info?.bit_depth ?? null,
      height: info?.height ?? null,
      main_audio: main ? `${main.codec}/${main.channels ?? "?"}ch` : null,
      main_audio_probe: main ? audioProbeAnswers(this.probe(), main.codec) : null,
      unsupported: this.support?.unsupported ?? null,
      position: Math.round(this.video?.currentTime ?? 0),
    };
  }

  // ------------------------------------------------------------------ compat audio

  /** The TV's compat choice: the panel's, else «always convert» from this device's playback profile. */
  compatPref(): CompatPref {
    const p = compatPrefStore.get();
    if (p !== "auto") return p;
    return devicePrefs.get()?.manual.audio === "always_compat" ? "on" : "auto";
  }

  /**
   * «Совместимый звук» is switched off on this TV, yet the file's video
   * (XviD… the server would re-encode) or main audio (e.g. DTS on a 2020+
   * Samsung) can't be decoded here while a compat stream would play: what
   * fails, for the player's notice, else null.
   */
  compatOffBlocks(): { kind: "video" | "audio"; codec: string } | null {
    const f = this.flow;
    if (f.phase !== "playing" || this.compat || this.compatPending !== null) return null;
    if (this.compatPref() !== "off" || !compatUrlOf(f.source) || !canPlayCompat(this.probe())) return null;
    const video = videoConvertNeeded(f.source, this.support) ? this.support?.parts.find((p) => p.kind === "video" && p.ok === false) : null;
    if (video) return { kind: "video", codec: video.label };
    const bad = this.support?.parts.find((p) => p.kind === "audio" && p.ok === false);
    return bad ? { kind: "audio", codec: bad.label } : null;
  }

  /** The notice's OK: back to «Авто» and convert this film now (also before its first frame). */
  enableCompatNow(): void {
    compatPrefStore.set("auto");
    const f = this.flow;
    if (f.phase === "playing" && !this.compat && this.compatPending === null && compatUrlOf(f.source)) {
      this.compatTried = true;
      void this.startCompat(this.trustedPosition(), true, null);
    }
    this.emit("playback");
  }

  /** A compat stream exists for this source and the engine plays MP4/AAC (unless switched off). */
  private compatPossible(src: PlaybackSource): boolean {
    return !!compatUrlOf(src) && this.compatPref() !== "off" && canPlayCompat(this.probe());
  }

  /** Should this source play in compat mode (start, or after the no-sound detector fired)? */
  private shouldCompat(src: PlaybackSource, noSound: boolean): boolean {
    return wantCompat({
      compatUrl: compatUrlOf(src),
      pref: this.compatPref(),
      canPlay: canPlayCompat(this.probe()),
      audioBad: audioUndecodable(this.support),
      noSound,
      videoBad: videoConvertNeeded(src, this.support),
    });
  }

  /** The engine exposes switchable audio tracks (video.audioTracks). */
  private engineTracks(): boolean {
    const list = (this.video as unknown as { audioTracks?: EngineList<EngineAudioTrack> } | null)?.audioTracks;
    return !!list && list.length > 0;
  }

  /**
   * (Re)starts the compat stream at absolute `at` with audio stream `audio`
   * (null = the profile's preferred voice-over / language, else default):
   * HEAD for the keyframe offset, then load start=K and count from K.
   */
  private async startCompat(at: number, play: boolean, audio: number | null) {
    const f = this.flow;
    if (f.phase !== "playing" || !this.video || !compatUrlOf(f.source)) return;
    const seq = ++this.compatSeq;
    const gen = this.gen;
    const stale = () => seq !== this.compatSeq || gen !== this.gen || this.flow.phase !== "playing" || !this.video;
    this.compatPending = Math.max(0, at);
    this.compatPlay = play;
    this.rebuf = null;
    this.emit("playback");
    let idx = audio ?? this.compat?.audio ?? null;
    if (idx === null) {
      const prefs = await loadPreferences(f.ctx.profile_id).catch(() => null);
      if (stale()) return;
      idx = pickCompatAudio(f.source.media_info, { voiceovers: prefs?.preferred_voiceovers, languages: prefs?.preferred_audio_languages });
    }
    const base = compatUrlOf(f.source)!;
    // The server re-encodes the video when this TV can't decode it (or a
    // decode error said so); keyframe offsets are the source's either way.
    const video = !!f.source.compat_video && (this.compatVideoForced || videoUndecodable(this.support ?? assessSource(f.source, this.probe())));
    const k = await fetchStreamStart(compatSrc(base, { audio: idx, start: at, video }), at);
    if (stale()) return;
    const cur = this.flow as Extract<Flow, { phase: "playing" }>;
    this.compat = { audio: idx, offset: k, video };
    this.compatPending = null;
    this.audioChecked = false;
    this.load(compatSrc(compatUrlOf(cur.source) ?? base, { audio: idx, start: k, video }), k, play, true);
    this.emit("playback");
  }

  /** A compat stream is (re)starting (seek / track switch): show loading. */
  compatRestarting(): boolean {
    return this.compatPending !== null;
  }

  /** For the panel / OSD / stats line. */
  compatState(): { active: boolean; available: boolean; pref: CompatPref; from: string | null; video: string | null } {
    const f = this.flow;
    const src = f.phase === "playing" ? f.source : null;
    return {
      active: !!this.compat || this.compatPending !== null,
      available: !!src && !!compatUrlOf(src) && canPlayCompat(this.probe()),
      pref: compatPrefStore.get(),
      from: this.compat ? sourceCodecLabel(src?.media_info, this.compat.audio) : null,
      // The source's video label («MPEG-4 (XviD)») while it is re-encoded to H.264.
      video: this.compat?.video ? (this.support?.parts.find((p) => p.kind === "video")?.label ?? src?.media_info?.video_codec ?? "?") : null,
    };
  }

  /** «Совместимый звук (AAC)»: on / off / auto, applied at the current position. */
  setCompatPref(p: CompatPref): void {
    compatPrefStore.set(p);
    const f = this.flow;
    if (f.phase !== "playing" || !this.isPlaying()) return;
    const at = this.trustedPosition();
    const play = !this.video!.paused || !!this.rebuf;
    const want = this.shouldCompat(f.source, false);
    if (want && !this.compat && this.compatPending === null) void this.startCompat(at, play, null);
    else if (!want && (this.compat || this.compatPending !== null) && p === "off" && f.source.stream_url) {
      this.load(f.source.stream_url, at, play);
      this.audioChecked = false;
    }
    this.emit("playback");
  }

  // ------------------------------------------------------------------ rebuffering / bandwidth

  private resetBandwidth() {
    this.rebuf = null;
    this.quiet = false;
    this.plateaus = 0;
    this.lastStall = null;
    this.stalls = [];
    this.rateSamples = [];
    this.rateEstimates = [];
    this.lastRate = null;
    this.rateFrom = Date.now() + rateWarmupMs();
    this.lowSince = null;
    this.slow = null;
    this.slowLog = SLOW_LOG0;
    this.frames = STUTTER0;
    this.frameTicks = 0;
    this.lastFrames = null;
    this.stutter = null;
    this.stutterSeen = false;
  }

  /**
   * Every ~2 s while playing: dropped frames over a steady stretch (not
   * paused / seeking / buffering, past the start-up grace). A sustained high
   * ratio notes the variant as rough on this TV (ranking, auto.rough) and
   * offers a lighter release once. Torrent / downloaded files only (online
   * HLS has its own qualities; a re-encoded compat video isn't the file's).
   */
  private watchFrames(v: HTMLVideoElement, now: number, src: PlaybackSource) {
    if (this.stutter && now - this.stutter.at > STUTTER_HINT_MS) {
      this.stutter = null;
      this.emit("playback");
    }
    if (++this.frameTicks % FRAME_EVERY !== 0) return;
    const c = readFrames(v);
    this.lastFrames = c;
    if (!c) return;
    const judged = (!src.kind || src.kind === "torrent") && !src.live && !this.compat?.video;
    const hidden = typeof document !== "undefined" && document.hidden;
    const steady =
      judged && !hidden && !v.paused && !v.seeking && !v.ended && v.readyState >= 3 && !this.rebuf && this.stallAt === null && v.playbackRate === 1 && now - this.seekedAt > FRAME_GRACE_MS;
    const r = stutterStep(this.frames, { at: now, total: c.total, dropped: c.dropped, steady });
    this.frames = r.state;
    if (!r.stutter || this.stutterSeen) return;
    this.stutterSeen = true;
    const token = sourceSmoothToken(src);
    console.info("[martytv] frames dropping", { ratio: r.ratio, token, release: src.release.id });
    if (token) {
      noteStutter(token);
      void devicePrefs.sync(true);
    }
    this.stutter = { at: now };
    this.emit("playback");
  }

  /** «Картинка подтормаживает…» while shown. */
  stutterHint(): boolean {
    return !!this.stutter;
  }

  /** A key on the hint: keep it up a while longer. */
  touchStutter() {
    if (this.stutter) this.stutter = { at: Date.now() };
  }

  dismissStutter() {
    this.stutter = null;
    this.emit("playback");
  }

  /** Dropped frames of this source's steady playback (the stats panel), or null when the engine doesn't count. */
  droppedFrames(): { pct: number; dropped: number } | null {
    const s = this.frames;
    if (!this.lastFrames || s.okFrames < 100) return null;
    return { pct: (s.okDropped / s.okFrames) * 100, dropped: s.okDropped };
  }

  /**
   * «Включить более лёгкую раздачу»: a release cheaper to decode (lower
   * resolution, H.264, SDR) at the same spot, via the normal start path;
   * none known → the picker at the same spot.
   */
  async smoother() {
    const f = this.flow;
    if (f.phase !== "playing") return;
    this.stutter = null;
    this.emit("playback");
    const gen = this.gen;
    const q = releaseQuery(f.ctx);
    let list = cachedReleases(q) ?? null;
    if (!list) list = await fetchReleases(q).catch(() => null);
    const now = this.flow;
    if (gen !== this.gen || now.phase !== "playing" || now.source.id !== f.source.id) return;
    const at = Math.floor(this.trustedPosition());
    const next = list ? smootherInstead(sourceDecodeCost(now.source), list.items, [...now.tried, now.source.release.id], this.rankEnv(now.ctx)) : null;
    if (next) return this.playRelease({ ...now.ctx, start_at: at }, next, at);
    this.gen++;
    this.dispatch({ type: "ctx", patch: { start_at: at } });
    this.dispatch({ type: "another" });
  }

  /** "waiting" after the first frame: pause ourselves until enough is buffered. */
  private onStall() {
    const v = this.video;
    const f = this.flow;
    if (!v || f.phase !== "playing" || f.ctx.player !== "builtin" || !this.started || v.paused || v.ended || this.rebuf || f.source.live) return;
    const now = Date.now();
    // Right after a seek / new stream a short wait is normal: rebuffer only
    // if it lasts (tick), so the remote stays responsive. After a rebuffer
    // already played out: only a long starvation counts (tick).
    if (now - this.seekedAt < 4000 || this.quiet) {
      this.stallAt ??= now;
      return;
    }
    this.stalls = [...this.stalls.filter((x) => x > now - STALL_WINDOW), now];
    this.startRebuffer(now, rebufferTarget(this.lastStall, false));
  }

  private startRebuffer(now: number, target: number) {
    const v = this.video;
    if (!v) return;
    this.stallAt = null;
    this.rebuf = { since: now, target, canPlayThrough: false, shown: 0, end: -1, grewAt: now, at: v.currentTime };
    try {
      v.pause();
    } catch {
      // ignore
    }
    this.emit("playback");
  }

  private endRebuffer(play: boolean) {
    const r = this.rebuf;
    if (!r) return;
    this.lastStall = (Date.now() - r.since) / 1000;
    this.rebuf = null;
    if (play) this.quiet = true;
    if (play) this.play();
    this.emit("playback");
  }

  /** OK while «Буферизация…»: play now. */
  resumeNow(): boolean {
    if (!this.rebuf) return false;
    this.endRebuffer(true);
    return true;
  }

  private bitrate(): number | null {
    const f = this.flow;
    if (f.phase !== "playing") return null;
    return sourceBitrate(f.source.file?.size_bytes, knownDuration(f.source));
  }

  /** Every 500 ms while the built-in player shows a source: rebuffer progress and the rate estimate. */
  /** The first-load watchdog's state (see FIRST_LOAD_STUCK_MS). */
  private firstLoad: { url: string | null; sig: string; since: number; tries: number } = { url: null, sig: "", since: 0, tries: 0 };

  private watchFirstLoad(v: HTMLVideoElement, now: number) {
    const w = this.firstLoad;
    const end = rangesOf(v).reduce((m, r) => Math.max(m, r[1]), 0);
    const sig = `${v.readyState}|${end.toFixed(1)}`;
    if (w.url !== this.loadedUrl) {
      // Another stream (a fresh URL keeps the retry count: same attempt).
      const sameLoad = w.url !== null && this.resumeAt !== null;
      this.firstLoad = { url: this.loadedUrl, sig, since: now, tries: sameLoad ? w.tries : 0 };
      return;
    }
    if (sig !== w.sig || (v.paused && v.readyState >= 2)) {
      w.sig = sig;
      w.since = now;
      return;
    }
    if (now - w.since < FIRST_LOAD_STUCK_MS * (w.tries + 1)) return;
    w.tries++;
    w.since = now;
    this.resumeAt = this.resumeAt ?? this.lastGood;
    void this.refreshUrl(true);
  }

  private tick() {
    const v = this.video;
    const f = this.flow;
    if (!v || f.phase !== "playing" || f.ctx.player !== "builtin" || this.loadedUrl === null || this.compatPending !== null) return;
    const now = Date.now();
    if (!this.started) {
      if (!this.compat && !f.source.live && f.source.kind !== "online") this.watchFirstLoad(v, now);
      return;
    }
    this.watchFrames(v, now, f.source);
    const ahead = bufferedAhead(rangesOf(v), v.currentTime);
    const bitrate = this.bitrate();
    // Buffer growth measures the link only while the engine is still
    // fetching; with a comfortable buffer the link isn't the limit.
    // Not right after a start / seek: the torrent is still finding peers.
    const short = (ahead < 20 || !!this.rebuf) && now >= this.rateFrom;
    if (ahead < 50) this.rateSamples = [...this.rateSamples.filter((x) => x.at > now - 30_000), { at: now, end: this.abs(v) + ahead }];
    else this.rateSamples = [];
    const rate = estimateRate(this.rateSamples, bitrate, now);
    if (rate !== null && short) {
      this.lastRate = rate;
      this.rateEstimates = [...this.rateEstimates, rate].slice(-240);
    }
    const bw = bandwidthCheck({ rate: short ? rate : null, bitrate, lowSince: this.lowSince, stalls: this.stalls, now });
    this.lowSince = bw.lowSince;
    const shown = this.lastRate ?? rate;
    if (this.slow && slowHintExpired(this.slow.at, now)) {
      // Nobody answered: hide it (it may come back once after a long cool-down).
      this.slow = null;
      this.slowLog = { ...this.slowLog, hiddenAt: now };
      this.emit("playback");
    } else if (bw.hint && bitrate && shown && !this.slow && slowHintAllowed(this.slowLog, now) && slowHintPref.get()) {
      this.slow = { rate: shown, bitrate, at: now };
      this.slowLog = { ...this.slowLog, shows: this.slowLog.shows + 1 };
      this.emit("playback");
    }
    if (this.stallAt !== null && !this.rebuf) {
      if (v.paused || v.readyState >= 3) this.stallAt = null;
      else if (now - this.stallAt > (this.quiet ? QUIET_STALL_MS : 3000) && !f.source.live) {
        if (this.quiet) this.stalls = [...this.stalls.filter((x) => x > now - STALL_WINDOW), now];
        this.startRebuffer(now, rebufferTarget(this.quiet ? this.lastStall : null, !this.quiet));
      }
    }
    const r = this.rebuf;
    if (!r) return;
    // Playing again without us (phone resume, play key, the engine after a long pause): the rebuffer is over.
    if (rebufferOutrun({ paused: v.paused, readyState: v.readyState, time: v.currentTime, timeAtStart: r.at })) {
      this.rebuf = null;
      this.emit("playback");
      return;
    }
    // Watch the buffered end: a paused engine that stopped fetching below the
    // target (stuck at «99 %») plays what it has; a stream that delivers
    // nothing at all for long is reloaded here (bounded by MAX_RECOVERIES).
    const end = this.abs(v) + ahead;
    if (end > r.end + 0.1) {
      r.end = end;
      r.grewAt = now;
    }
    // Plateau resumes that stall again right away wait longer each time
    // (no play/pause loop every few seconds).
    if (now - this.plateauAt > 60_000) this.plateaus = 0;
    const stuckMs = (now - r.grewAt) / 2 ** Math.min(this.plateaus, 3);
    const done = rebufferDone({ ahead, target: r.target, canPlayThrough: r.canPlayThrough, time: this.abs(v), duration: this.duration(), stuckMs });
    if (done) {
      if (done === "plateau") {
        this.plateaus++;
        this.plateauAt = now;
      }
      this.endRebuffer(true);
      return;
    }
    if (rebufferDead(ahead, now - r.grewAt) && !f.source.live) {
      this.resumeAt = this.trustedPosition();
      this.rebuf = null;
      this.recoverPrematureEnd();
      return;
    }
    this.emit("playback");
  }

  /** A short native stall after a played-out rebuffer: keep the picture, no spinner. */
  quietStall(): boolean {
    return this.quiet && !this.rebuf && !this.video?.seeking;
  }

  /** «Буферизация… N%» with seconds ahead and Mbit/s; null when not rebuffering. */
  rebuffering(): { pct: number; ahead: number; rate: number | null } | null {
    const r = this.rebuf;
    const v = this.video;
    if (!r || !v) return null;
    const ahead = bufferedAhead(rangesOf(v), v.currentTime);
    r.shown = Math.max(r.shown, rebufferPercent(ahead, r.target));
    return { pct: r.shown, ahead, rate: this.lastRate };
  }

  /** Seconds buffered ahead of the playhead («Показывать буфер»); null when no built-in video plays. */
  bufferAhead(): number | null {
    const v = this.video;
    const f = this.flow;
    if (!v || f.phase !== "playing" || f.ctx.player !== "builtin" || this.loadedUrl === null || !this.started) return null;
    return bufferedAhead(rangesOf(v), v.currentTime);
  }

  /** Server → this TV for the stats panel: this session's estimate, else the TV's usual rate. */
  deviceRate(): { bps: number; measured: boolean } | null {
    if (this.lastRate) return { bps: this.lastRate, measured: true };
    const usual = rateStore.get();
    return usual ? { bps: usual, measured: false } : null;
  }

  /** «Скорость соединения ниже…» (see rebuffer.ts for when it shows / hides). */
  slowHint(): { rate: number; bitrate: number } | null {
    return this.slow;
  }

  /** A key on the hint (moving between its buttons): keep it up a while longer. */
  touchSlow() {
    if (this.slow) this.slow = { ...this.slow, at: Date.now() };
  }

  /** Back / «Не сейчас»: gone for the rest of this playback. */
  dismissSlow() {
    this.slow = null;
    this.slowLog = { ...this.slowLog, dismissed: true, hiddenAt: Date.now() };
    this.emit("playback");
  }

  /** «Выбрать раздачу полегче»: the picker at the same position, releases under the measured rate first. */
  lighter() {
    const f = this.flow;
    if (f.phase !== "playing") return;
    const rate = this.slow?.rate ?? this.lastRate ?? rateStore.get();
    const at = this.trustedPosition();
    this.slow = null;
    this.slowLog = { ...this.slowLog, dismissed: true };
    this.gen++;
    this.dispatch({ type: "ctx", patch: { start_at: Math.floor(at) } });
    // Before "another": the picker renders during that dispatch.
    this.lighterRate = rate;
    this.dispatch({ type: "another" });
  }

  /**
   * «Другая раздача» from the slow-torrent hint (loading screen or a
   * rebuffer): the picker at the same position, releases that fit the
   * torrent's measured speed (`rateBits`, bits/s) first; the slow one is
   * stopped on the server.
   */
  slowAnother(rateBits: number | null) {
    const f = this.flow;
    if (f.phase !== "preparing" && f.phase !== "playing") return;
    const at = f.phase === "playing" && this.started ? this.trustedPosition() : f.startAt;
    this.cancelLoading();
    this.slow = null;
    this.gen++;
    this.dispatch({ type: "ctx", patch: { start_at: Math.floor(at) } });
    if (rateBits && rateBits > 0) this.lighterRate = rateBits;
    this.dispatch({ type: "another" });
  }

  /**
   * The session's rate sample for this TV's memory (and its device profile):
   * the median of estimates taken while the link was the limit; a session
   * that played a known bitrate without stalls proves at least that much.
   */
  private recordRate() {
    const est = sessionRate(this.rateEstimates);
    const bitrate = this.bitrate();
    const proven = bitrate && this.started && this.stalls.length === 0 && this.lastGood - this.loadedAt > 120 ? bitrate * 1.2 : null;
    const sample = sessionSample(est, proven);
    this.rateEstimates = [];
    if (!sample) return;
    rateStore.add(sample);
    devicePrefs.noteThroughput(rateStore.get());
  }

  // ------------------------------------------------------------------ commands

  /** True while continuing after a cut-off stream (the UI shows loading). */
  recovering(): boolean {
    return this.resumeAt !== null;
  }

  /** The position minus unexplained jumps (what progress reports and errors keep). */
  trustedPosition(): number {
    if (this.resumeAt !== null) return this.resumeAt;
    const v = this.video;
    const p = this.position();
    const allowed = Date.now() <= this.seekAllowedUntil;
    if (v && (isUnexplainedJump(p, this.lastGood, allowed) || isUnexplainedDrop(p, this.lastGood, allowed))) return this.lastGood;
    return p;
  }

  /**
   * A real end: the last trusted position is close to the file's true length
   * (the server's ffprobe duration wins over the engine's, which a cut-off
   * stream can shorten). Anything else is a broken stream, not the credits.
   */
  endedForReal(): boolean {
    const f = this.flow;
    if (f.phase !== "playing") return true;
    const v = this.video;
    // A compat stream's own length is only its fragment: ffprobe's wins.
    const engine = v && !this.compat && isFinite(v.duration) && v.duration > 0 ? v.duration : null;
    // Online sources have no ffprobe info: the provider's length stands in.
    return isRealEnd(this.resumeAt ?? this.lastGood, knownDuration(f.source), engine);
  }

  /** Premature end / jump: show loading, fresh URL, continue at the trusted spot. */
  private recoverPrematureEnd() {
    const f = this.flow;
    const v = this.video;
    if (f.phase !== "playing" || !v) return;
    const at = this.resumeAt ?? this.lastGood;
    this.resumeAt = at;
    this.recoverFrom = at;
    if (++this.recoveries > MAX_RECOVERIES) {
      this.recoveries = 0;
      return this.dispatch({ type: "fail", code: "network" });
    }
    this.emit("playback");
    void this.refreshUrl(true);
  }

  position(): number {
    const f = this.flow;
    if (f.phase === "preparing") return f.startAt;
    if (f.phase !== "playing") return 0;
    const v = this.video;
    if (this.compatPending !== null) return this.compatPending;
    if (this.awaitingInfo()) return this.infoWait!.at;
    if (!v || this.loadedUrl === null) return f.startAt;
    return this.pendingSeek ?? this.abs(v);
  }

  /** Absolute time of the element (compat: + the stream's offset). */
  private abs(v: HTMLVideoElement): number {
    return absTime(this.compat?.offset ?? 0, v.currentTime);
  }

  duration(): number | null {
    const v = this.video;
    if (v && !this.compat && isFinite(v.duration) && v.duration > 0) return v.duration;
    const f = this.flow;
    return f.phase === "playing" || f.phase === "preparing" ? knownDuration(f.source) : null;
  }

  isPlaying(): boolean {
    return this.flow.phase === "playing" && this.flow.ctx.player === "builtin" && !!this.video;
  }

  pause(): boolean {
    if (!this.isPlaying()) return false;
    // Pausing while rebuffering: now it's the user's pause.
    this.rebuf = null;
    this.video!.pause();
    this.emit("playback");
    return true;
  }

  resume(): boolean {
    if (!this.isPlaying()) return false;
    const v = this.video!;
    // Play while rebuffering: the user resumes early.
    if (this.rebuf) return this.endRebuffer(true), true;
    if (v.ended) v.currentTime = 0;
    this.play();
    this.emit("playback");
    return true;
  }

  toggle() {
    if (this.video?.paused) this.resume();
    else this.pause();
  }

  /** The user's pause (the rebuffer's own pause doesn't count). */
  userPaused(): boolean {
    const v = this.video;
    return !!v && v.paused && !this.rebuf;
  }

  seekTo(pos: number): boolean {
    if (!this.isPlaying()) return false;
    if (this.awaitingInfo()) {
      // Nothing loaded yet: the first load starts there.
      this.infoWait!.at = Math.max(0, pos);
      this.seeks++;
      this.emit("playback");
      return true;
    }
    const v = this.video!;
    this.seekAllowedUntil = Date.now() + 8000;
    this.resumeAt = null;
    const d = this.duration();
    const target = Math.max(0, d ? Math.min(pos, Math.max(0, d - 1)) : pos);
    // The user's target is the new trusted spot. Before, lastGood stayed at
    // the old position until a timeupdate within 8 s confirmed the seek: a
    // slow seek (online HLS on a weak box, a torrent finding the new piece)
    // landed after that window, counted as an «unexplained jump» and the
    // recovery reloaded the stream at the OLD position — the seek bounced
    // back, again and again. A backward seek left lastGood ahead too, so a
    // later recovery jumped forward to where the viewer had been.
    this.lastGood = target;
    this.seeks++;
    this.seekCheck = null;
    this.seekedAt = Date.now();
    // A new position: it may show «Буферизация» once again.
    this.quiet = false;
    this.rateFrom = Math.max(this.rateFrom, this.seekedAt + rateWarmupMs());
    this.rateSamples = [];
    // A seek while rebuffering: a new position and target — the percentage starts over.
    if (this.rebuf) Object.assign(this.rebuf, { target: rebufferTarget(null, true), shown: 0, end: -1, grewAt: Date.now() });
    if (this.compat || this.compatPending !== null) {
      // No Range on compat streams: within the buffer, else restart at target.
      const plan = this.compat && this.compatPending === null ? compatSeek(target, this.compat.offset, rangesOf(v)) : { kind: "reload" as const, at: target };
      if (plan.kind === "local") v.currentTime = plan.at;
      // While a restart is pending the element may not play yet (the first
      // compat load): keep that restart's intent, else this seek would load paused.
      else void this.startCompat(plan.at, !v.paused || !!this.rebuf || (this.compatPending !== null && this.compatPlay), this.compat?.audio ?? null);
      this.emit("playback");
      return true;
    }
    if (this.freshUrl) {
      this.load(this.freshUrl, target, !v.paused);
    } else if (this.pendingSeek !== null || v.readyState === 0) {
      this.pendingSeek = target;
    } else {
      v.currentTime = target;
    }
    this.emit("playback");
    return true;
  }

  tracks(): TrackInfo {
    const f = this.flow;
    const info = f.phase === "playing" ? f.source.media_info : null;
    const v = this.video;
    const out: TrackInfo = { audio: [], subtitles: [], audioId: null, subtitleId: null, canAudio: false, canSubtitles: false };
    const engineAudio = (v as unknown as { audioTracks?: EngineList<EngineAudioTrack> } | null)?.audioTracks;
    const src = f.phase === "playing" ? f.source : null;
    if (info && (this.compat || (src && this.compatPossible(src) && !(engineAudio && engineAudio.length > 0)))) {
      // Compat: media_info tracks, switched by restarting with audio=<index>
      // (also offered when the engine can't switch tracks itself).
      out.canAudio = true;
      info.audio.forEach((s, i) => out.audio.push({ id: `a${i}`, label: trackLabel(s, i), language: normLang(s.language) }));
      const def = info.audio.findIndex((s) => s.default);
      out.audioId = this.compat ? trackIdOf(info, this.compat.audio) : info.audio.length > 0 ? `a${Math.max(0, def)}` : null;
    } else if (engineAudio && engineAudio.length > 0) {
      out.canAudio = true;
      for (let i = 0; i < engineAudio.length; i++) {
        const t = engineAudio[i]!;
        const meta = info?.audio[i];
        out.audio.push({ id: `a${i}`, label: trackLabel({ ...meta, language: t.language || meta?.language }, i, t.label), language: normLang(t.language || meta?.language) });
        if (t.enabled) out.audioId = `a${i}`;
      }
    } else if (info) {
      info.audio.forEach((s, i) => out.audio.push({ id: `a${i}`, label: trackLabel(s, i), language: normLang(s.language) }));
      const def = info.audio.findIndex((s) => s.default);
      out.audioId = info.audio.length > 0 ? `a${Math.max(0, def)}` : null;
    }
    const text = v?.textTracks;
    const subs: TextTrack[] = [];
    if (text) for (let i = 0; i < text.length; i++) if (text[i]!.kind === "subtitles" || text[i]!.kind === "captions") subs.push(text[i]!);
    if (subs.length > 0) {
      out.canSubtitles = true;
      subs.forEach((t, i) => {
        out.subtitles.push({ id: `s${i}`, label: trackLabel({ language: t.language }, i, t.label), language: normLang(t.language) });
        if (t.mode === "showing") out.subtitleId = `s${i}`;
      });
    } else if (info) {
      info.subtitles.forEach((s, i) => out.subtitles.push({ id: `s${i}`, label: trackLabel(s, i), language: normLang(s.language) }));
    }
    return out;
  }

  /** Switches audio. "unsupported" when the engine can't (tracks come from media_info only). */
  setAudio(id: string): true | "unsupported" | "bad_payload" | "failed" {
    if (!this.isPlaying()) return "failed";
    const t = this.tracks();
    if (!t.audio.some((a) => a.id === id)) return "bad_payload";
    if (!t.canAudio) return "unsupported";
    const f = this.flow;
    if (f.phase === "playing" && (this.compat || this.compatPending !== null || !this.engineTracks())) {
      // Compat (or an engine that can't switch): restart the compat stream
      // with that track at the current position.
      const idx = audioIndexOf(f.source.media_info, id);
      if (idx === null) return "bad_payload";
      if (this.compat?.audio === idx) return true;
      void this.startCompat(this.trustedPosition(), !this.video!.paused || !!this.rebuf, idx);
      this.emit("playback");
      return true;
    }
    const list = (this.video as unknown as { audioTracks: EngineList<EngineAudioTrack> }).audioTracks;
    const idx = Number(id.slice(1));
    for (let i = 0; i < list.length; i++) list[i]!.enabled = i === idx;
    this.emit("playback");
    return true;
  }

  /** Switches subtitles (null = off). */
  setSubtitles(id: string | null): true | "unsupported" | "bad_payload" | "failed" {
    if (!this.isPlaying()) return "failed";
    const t = this.tracks();
    if (id !== null && !t.subtitles.some((s) => s.id === id)) return "bad_payload";
    if (!t.canSubtitles) return id === null ? true : "unsupported";
    const text = this.video!.textTracks;
    let n = 0;
    for (let i = 0; i < text.length; i++) {
      const tt = text[i]!;
      if (tt.kind !== "subtitles" && tt.kind !== "captions") continue;
      tt.mode = id === `s${n}` ? "showing" : "disabled";
      n++;
    }
    this.emit("playback");
    return true;
  }

  /** Online source: its qualities (best first) and the current one; null otherwise. */
  qualities(): { list: number[]; current: number | null } | null {
    const f = this.flow;
    if (f.phase !== "playing" || f.source.kind !== "online") return null;
    const list = [...(f.source.qualities ?? [])].sort((a, b) => b - a);
    return list.length > 1 ? { list, current: f.source.quality ?? list[0] ?? null } : null;
  }

  /** Switches an online source's quality (PATCH), continuing at the same spot. */
  async setQuality(q: number): Promise<boolean> {
    const f = this.flow;
    if (f.phase !== "playing" || f.source.kind !== "online" || !this.isPlaying()) return false;
    const gen = this.gen;
    const at = this.trustedPosition();
    const play = !this.video!.paused;
    try {
      const src = await patchQuality(f.source.id, q);
      if (gen !== this.gen || this.flow.phase !== "playing" || src.status !== "ready" || !src.stream_url) return false;
      this.dispatch({ type: "source", source: src });
      this.scheduleRefresh(src);
      this.resumeAt = null;
      this.load(reloadUrl(src.stream_url, this.loadedUrl, q), at, play);
      this.emit("playback");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The intro / recap the position is in (the skip pill), or — `ending`:
   * a series with a next episode — the credits (source.markers: chapters,
   * the provider, TheIntroDB / IntroDB).
   */
  skipMarker(ending = false) {
    const f = this.flow;
    if (f.phase !== "playing" || !this.isPlaying()) return null;
    return skipTarget(f.source.markers, this.position(), this.duration() ?? 0, ending);
  }

  /** «Пропустить заставку / пересказ»: to its end. */
  skipPast(m: { end_seconds: number }): boolean {
    const d = this.duration() ?? 0;
    return this.seekTo(d > 0 ? Math.min(m.end_seconds, d - 1) : m.end_seconds);
  }

  /** PlaybackState for device.state (null when nothing plays). */
  playback(): PlaybackState | null {
    const f = this.flow;
    if (f.phase !== "preparing" && f.phase !== "playing") return null;
    const ctx = f.ctx;
    const external = f.phase === "playing" && ctx.player !== "builtin";
    const v = f.phase === "playing" && !external ? this.video : null;
    const tr = v ? this.tracks() : null;
    const dur = external ? knownDuration(f.source) : this.duration();
    return {
      media_id: ctx.media_id,
      episode_id: ctx.episode_id,
      title: ctx.title,
      episode_label: episodeLabel(ctx.season, ctx.episode, ctx.episode_name),
      source_id: f.source?.id ?? null,
      position_seconds: external ? 0 : Math.floor(this.position()),
      duration_seconds: dur !== null ? Math.round(dur) : null,
      paused: v ? v.paused && !this.rebuf : false,
      buffering: v ? v.seeking || v.readyState < 3 || !!this.rebuf || this.compatPending !== null : !external,
      volume: v ? Math.round(v.volume * 100) / 100 : null,
      audio_tracks: tr?.audio ?? [],
      subtitle_tracks: tr?.subtitles ?? [],
      audio_track_id: tr?.audioId ?? null,
      subtitle_track_id: tr?.subtitleId ?? null,
      loading: external ? null : this.loadingState(),
    };
  }

  /** The failure the player screen shows (DeviceState.player_error), else null. */
  failure(): string | null {
    const f = this.flow;
    return f.phase === "failed" ? (f.kind === "unplayable" ? f.code || "unplayable" : f.code) : null;
  }
}

/** The title's length the server knows: ffprobe for torrents, the provider's for online sources. */
function knownDuration(src: PlaybackSource | null | undefined): number | null {
  return src?.media_info?.duration_seconds ?? src?.duration_seconds ?? null;
}

/** Whether the engine decoded any audio (null-safe across engines). */
export const player = new PlayerController();
// Media element errors (decode / unsupported) carry what was playing and how.
setMediaContext(() => player.mediaContext());

// Page lifecycle: report the position when the TV app is hidden or unloaded
// (MSX switching away, the TV's Home button, closing the page).
if (typeof window !== "undefined" && typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") player.pageHidden();
  });
  window.addEventListener("pagehide", () => player.pageHidden());
}

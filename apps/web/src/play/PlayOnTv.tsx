import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Device, PlaybackSource, Release } from "@martytv/contracts";
import { loadStatus, Spinner, useI18n, type LoadStatusStage } from "@martytv/ui";
import { usePickerDevices } from "../remote/AllDevicesToggle";
import { AlertIcon, CheckIcon, CloseIcon, DeviceIcon, ListIcon, PlayIcon, RemoteIcon } from "../icons";
import { watchUrl } from "../player/logic";
import { writeWatchWhere } from "../player/session";
import { useActiveProfile } from "../watch/ActiveProfile";
import { chooseDevice, errorMessage, errorOutcome, ackOutcome, focusDevice } from "../remote/logic";
import { sendCommand, setLastUsedDevice, useDeviceStates, useLastUsedDevice, type LiveState } from "../remote/state";
import { BusyDialog, DevicePicker, Sheet } from "../remote/SendToTv";
import { createPlayController, holdTvProgress, isBusy, PLAY_IDLE, playPayload, tvProgress, type PlayFlow, type PlayRequest, type TvPeak } from "./flow";
import { usePlaybackSource } from "./queries";
import { ReleaseList } from "./ReleaseList";
import { PlayerPicker } from "./PlayerPicker";
import { PlayHereSheet } from "./PlayHere";
import { DownloadSheet } from "../downloads/DownloadSheet";
import { saveTargetFor, useSaveToDevice } from "../offline/ui";
import { decidePlayer, rememberedPlayer, rememberPlayer } from "./players";
import {
  codecLabel,
  formatSize,
  formatSpeed,
  qualityLabel,
  rankingProfileId,
  resolutionLabel,
  sourceErrorMessage,
  type ReleaseTarget,
} from "./releases";

/** What a release sheet / play button is about: a movie or one episode. */
export interface PlayTarget extends ReleaseTarget {
  label: string;
  /** Sheet subtitle, e.g. the episode name. */
  detail?: string;
  /** Resume position sent with media.play. */
  position_seconds?: number;
  /** «Раздача полегче»: rank for this browser, releases under the measured rate first. */
  budget?: { bps: number; duration_seconds: number };
}

interface PlayCtx {
  flow: PlayFlow;
  play: (req: PlayRequest) => void;
  /** Play on this TV (no picker). */
  playOn: (req: PlayRequest, deviceId: string) => void;
  chooseRelease: (target: PlayTarget) => void;
  /** The picker's TVs with live online flags (undefined while loading) and their states. */
  tvs: Device[] | undefined;
  states: Record<string, LiveState>;
  lastUsed: string | null;
}

const Ctx = createContext<PlayCtx | null>(null);

export function usePlayOnTv() {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePlayOnTv must be used inside PlayOnTvProvider");
  return v;
}

/**
 * Owns "Play on TV" for a page: release sheet, TV picker, busy confirmation,
 * source preparation and the progress toast.
 */
export function PlayOnTvProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data: devices } = usePickerDevices();
  const states = useDeviceStates(devices);
  const lastUsed = useLastUsedDevice();
  const [flow, setFlow] = useState<PlayFlow>(PLAY_IDLE);
  const [sheet, setSheet] = useState<PlayTarget | null>(null);
  const [here, setHere] = useState<{ target: PlayTarget; release: Release } | null>(null);
  const [download, setDownload] = useState<{ target: PlayTarget; release: Release } | null>(null);
  const navigate = useNavigate();
  const { profileId: activeProfileId } = useActiveProfile();
  const saveDevice = useSaveToDevice();

  // Created once: media.play goes out at once — the TV searches / prepares itself.
  const [ctl] = useState(() =>
    createPlayController(setFlow, {
      send: (s) => {
        setLastUsedDevice(s.deviceId);
        return sendCommand(qc, s.deviceId, "media.play", playPayload(s.req, s.force))
          .then(ackOutcome, errorOutcome)
          .then((outcome) => ({ type: "outcome", outcome }));
      },
    }),
  );
  const dispatch = ctl.dispatch;

  const live = useMemo(
    () => (devices ?? []).map((d) => ({ ...d, online: states[d.id]?.online ?? d.online })),
    [devices, states],
  );

  // Which TV player to use is decided once the TV is known (see decidePlayer).
  const decide = useCallback(
    (deviceId: string, req: PlayRequest) =>
      decidePlayer(states[deviceId]?.state, rememberedPlayer(deviceId), { force: req.askPlayer, requested: req.player }),
    [states],
  );
  const play = useCallback(
    (req: PlayRequest) => {
      writeWatchWhere("tv");
      const choice = chooseDevice(live, lastUsed);
      dispatch({ type: "request", req, choice, ...(choice.kind === "auto" && { player: decide(choice.deviceId, req) }) });
    },
    [dispatch, live, lastUsed, decide],
  );
  const playOn = useCallback(
    (req: PlayRequest, deviceId: string) => {
      writeWatchWhere("tv");
      dispatch({ type: "request", req, choice: { kind: "auto", deviceId }, player: decide(deviceId, req) });
    },
    [dispatch, decide],
  );
  const tvs = devices ? live : undefined;
  const ctx = useMemo<PlayCtx>(
    () => ({ flow, play, playOn, chooseRelease: setSheet, tvs, states, lastUsed }),
    [flow, play, playOn, tvs, states, lastUsed],
  );

  // Rank the list for whoever watches on the TV this will most likely go to.
  const rankTv = focusDevice(live, lastUsed);
  const rankState = rankTv ? states[rankTv.id]?.state : null;
  // The TV whose playback profile ranks the list: the focused one, else the last used / only TV.
  const profileTv = rankTv ?? live.find((d) => d.id === lastUsed) ?? (live.length === 1 ? live[0]! : null);
  const nameOf = (id: string | null) => live.find((d) => d.id === id)?.name ?? "TV";

  return (
    <Ctx.Provider value={ctx}>
      {children}
      {sheet && (
        <Sheet
          wide
          title={sheet.label}
          subtitle={sheet.detail}
          onClose={() => setSheet(null)}
          testId="release-sheet"
        >
          <SheetBody
            target={sheet}
            // No TV reporting a profile: rank (and pick sources) for the profile using this browser.
            profileId={rankingProfileId(rankState) ?? activeProfileId ?? undefined}
            profileName={rankState?.profile_name}
            deviceId={profileTv?.id}
            onPick={(r) => {
              setSheet(null);
              play({ ...sheet, release_id: r.id });
            }}
            onPickWith={(r) => {
              setSheet(null);
              play({ ...sheet, release_id: r.id, askPlayer: true });
            }}
            onPlayHere={(r) => {
              setSheet(null);
              setHere({ target: sheet, release: r });
            }}
            onDownload={(r) => {
              setSheet(null);
              setDownload({ target: sheet, release: r });
            }}
            onSaveDevice={(r) => {
              setSheet(null);
              saveDevice(saveTargetFor(qc, sheet, r.id));
              navigate("/downloads#device");
            }}
            onWatchHere={(r) => {
              setSheet(null);
              writeWatchWhere("here");
              navigate(watchUrl(sheet, { release: r.id, t: sheet.position_seconds }));
            }}
          />
        </Sheet>
      )}
      {here && <PlayHereSheet target={here.target} release={here.release} onClose={() => setHere(null)} />}
      {download && <DownloadSheet target={download.target} release={download.release} onClose={() => setDownload(null)} />}
      {flow.step === "player" && (
        <PlayerPicker
          tv={nameOf(flow.deviceId)}
          options={flow.options}
          preselected={flow.preselected}
          tvDefault={states[flow.deviceId]?.state?.default_player ?? null}
          onPick={(p) => {
            rememberPlayer(flow.deviceId, p);
            dispatch({ type: "player", player: p });
          }}
          onClose={() => dispatch({ type: "cancel" })}
        />
      )}
      {flow.step === "picking" && (
        <DevicePicker
          devices={live}
          states={states}
          preferred={flow.preferred ?? lastUsed}
          onPick={(id) => dispatch({ type: "pick", deviceId: id, player: decide(id, flow.req) })}
          onClose={() => dispatch({ type: "cancel" })}
        />
      )}
      {flow.step === "confirm" && (
        <BusyDialog
          play
          tv={nameOf(flow.deviceId)}
          state={states[flow.deviceId]}
          onConfirm={() => dispatch({ type: "confirm" })}
          onCancel={() => dispatch({ type: "cancel" })}
        />
      )}
      {(isBusy(flow) || flow.step === "done") && (
        <PlayToast
          key={"req" in flow ? `${flow.req.media_id}:${flow.req.episode_id ?? ""}:${flow.req.release_id ?? ""}` : "idle"}
          flow={flow as Exclude<PlayFlow, { step: "idle" | "picking" | "player" | "confirm" }>}
          tv={nameOf("deviceId" in flow ? flow.deviceId : null)}
          live={"deviceId" in flow ? states[flow.deviceId] : undefined}
          onDismiss={() => dispatch({ type: "dismiss" })}
          onAnother={(target) => {
            dispatch({ type: "dismiss" });
            setSheet(target);
          }}
        />
      )}
    </Ctx.Provider>
  );
}

function SheetBody({
  target,
  profileId,
  profileName,
  deviceId,
  onPick,
  onPickWith,
  onPlayHere,
  onWatchHere,
  onDownload,
  onSaveDevice,
}: {
  target: PlayTarget;
  profileId: string | undefined;
  profileName: string | null | undefined;
  deviceId: string | undefined;
  onPick: (r: Release) => void;
  onPickWith: (r: Release) => void;
  onPlayHere: (r: Release) => void;
  onWatchHere: (r: Release) => void;
  onDownload: (r: Release) => void;
  onSaveDevice: (r: Release) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-accent">{t("player.choose_release")}</p>
      <ReleaseList
        target={target}
        profileId={profileId}
        profileName={profileName}
        deviceId={deviceId}
        onPick={onPick}
        onPickWith={onPickWith}
        onPlayHere={onPlayHere}
        onWatchHere={onWatchHere}
        onDownload={onDownload}
        onSaveDevice={onSaveDevice}
        budget={target.budget}
      />
    </div>
  );
}

// ---------------------------------------------------------------- buttons

/** Hero action: plays the best-ranked release without opening the list. */
export function PlayOnTvButton({
  target,
  className = "",
  label,
  testId = "play-on-tv",
}: {
  target: PlayTarget;
  className?: string;
  /** Overrides "Play on TV" (e.g. "Resume at 42:10"). */
  label?: string;
  testId?: string;
}) {
  const { t } = useI18n();
  const { flow, play } = usePlayOnTv();
  const busy = isBusy(flow);
  const mine = busy && "req" in flow && flow.req.media_id === target.media_id && flow.req.episode_id === target.episode_id;
  return (
    <button
      type="button"
      onClick={() => play(target)}
      disabled={busy}
      data-testid={testId}
      className={`inline-flex min-h-[52px] items-center justify-center gap-2.5 rounded-xl bg-accent px-7 text-lg font-bold text-on-accent shadow-lg shadow-black/30 transition hover:bg-accent-strong disabled:opacity-60 ${className}`}
    >
      {mine ? <Spinner size={20} /> : <PlayIcon className="text-[22px]" />}
      {label ?? t("player.play_on_tv")}
    </button>
  );
}

/** Opens the in-browser player (best release for this browser, prepared on the player page). */
export function useWatchHere() {
  const navigate = useNavigate();
  return useCallback(
    (target: PlayTarget, opts: { release?: string } = {}) => {
      writeWatchWhere("here");
      navigate(watchUrl(target, { release: opts.release, t: target.position_seconds }));
    },
    [navigate],
  );
}

/** "Watch here": next to "Play on TV". */
export function WatchHereButton({
  target,
  className = "",
  label,
  testId = "watch-here",
}: {
  target: PlayTarget;
  className?: string;
  label?: string;
  testId?: string;
}) {
  const { t } = useI18n();
  const watchHere = useWatchHere();
  return (
    <button
      type="button"
      onClick={() => watchHere(target)}
      data-testid={testId}
      className={`inline-flex min-h-[48px] items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-accent/60 bg-surface/70 px-4 font-semibold text-text backdrop-blur transition hover:border-accent hover:bg-accent/10 sm:px-5 ${className}`}
    >
      <DeviceIcon className="text-xl text-accent" />
      {label ?? t("player.web.watch_here")}
    </button>
  );
}

export function ChooseReleaseButton({ target, className = "" }: { target: PlayTarget; className?: string }) {
  const { t } = useI18n();
  const { chooseRelease } = usePlayOnTv();
  return (
    <button
      type="button"
      onClick={() => chooseRelease(target)}
      data-testid="choose-release"
      className={`inline-flex min-h-[48px] items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-border bg-surface/70 px-4 font-semibold backdrop-blur transition hover:border-accent sm:px-5 ${className}`}
    >
      <ListIcon className="text-xl" />
      {t("player.releases")}
    </button>
  );
}

/** Episode row: play best (big) + choose release (small), stacked. */
export function EpisodePlayButtons({ target, code }: { target: PlayTarget; code: string }) {
  const { t } = useI18n();
  const { flow, play, chooseRelease } = usePlayOnTv();
  const watchHere = useWatchHere();
  const busy = isBusy(flow);
  const mine = busy && "req" in flow && flow.req.episode_id === target.episode_id;
  const playLabel = t("player.play_episode", { code });
  const listLabel = t("player.releases_for", { code });
  const hereLabel = t("player.web.watch_episode_here", { code });
  return (
    <div className="flex shrink-0 flex-col items-center gap-1.5 self-center">
      <button
        type="button"
        onClick={() => play(target)}
        disabled={busy}
        aria-label={playLabel}
        title={playLabel}
        data-testid="episode-play"
        className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-xl text-on-accent transition hover:bg-accent-strong disabled:opacity-50"
      >
        {mine ? <Spinner size={18} /> : <PlayIcon className="translate-x-px" />}
      </button>
      <button
        type="button"
        onClick={() => watchHere({ ...target, position_seconds: undefined })}
        aria-label={hereLabel}
        title={hereLabel}
        data-testid="episode-watch-here"
        className="flex h-9 w-9 items-center justify-center rounded-full border border-accent/50 bg-surface-2 text-base text-accent transition hover:border-accent hover:bg-accent/10"
      >
        <DeviceIcon />
      </button>
      <button
        type="button"
        onClick={() => chooseRelease(target)}
        aria-label={listLabel}
        title={listLabel}
        data-testid="episode-releases"
        className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-2 text-base text-text/80 transition hover:border-accent hover:text-accent"
      >
        <ListIcon />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- progress toast

export function releaseSummary(r: Release, locale: string): string {
  // Online variant: voice, quality and source (no size / codec).
  if (r.provider && r.provider.kind !== "torrent") {
    return [r.voiceovers[0]?.studio, resolutionLabel(r.resolution), r.provider.name].filter(Boolean).join(" · ");
  }
  return [resolutionLabel(r.resolution), qualityLabel(r.source_quality), codecLabel(r.video_codec), formatSize(r.size_bytes, locale)]
    .filter(Boolean)
    .join(" · ");
}

/** Live status line for a source: preparing (peers, speed) / ready / error. */
export function useSourceStatus(source: PlaybackSource | null, enabled: boolean) {
  const { t, locale } = useI18n();
  const q = usePlaybackSource(enabled ? source?.id : null, source);
  const s = q.data ?? source;
  if (!s) return null;
  if (s.status === "error") return { kind: "error" as const, text: sourceErrorMessage(s.error, t), source: s };
  if (s.status === "ready") return { kind: "ready" as const, text: t("player.ready"), source: s };
  const tor = s.torrent;
  const stats =
    tor && tor.peers > 0
      ? t("player.peers_speed", { peers: tor.peers, speed: formatSpeed(tor.download_speed_bps, locale) })
      : t("player.connecting_peers");
  return { kind: "preparing" as const, text: stats, source: s };
}

/** One line for the TV's loading stage and its live torrent numbers («Пиров 14 · сидов 9 · ↓ 2,4 МБ/с»). */
function useTvLoadLines(p: ReturnType<typeof tvProgress>): { stage: string | null; stats: string | null } {
  const { t, locale } = useI18n();
  if (p.kind !== "loading") return { stage: null, stats: null };
  const torrent =
    p.peers != null
      ? { peers: p.peers, seeders: p.seeders ?? 0, download_speed_bps: p.speed ?? 0, preloaded_bytes: p.buffered ?? 0 }
      : null;
  const known: LoadStatusStage[] = ["creating", "metadata", "preloading", "starting"];
  const stage = (known as string[]).includes(p.stage) ? (p.stage as LoadStatusStage) : "starting";
  const st = loadStatus({ stage, torrent }, { bytes: (n) => formatSize(n, locale), speed: (b) => formatSpeed(b, locale) });
  return {
    stage: t(st.status.key, st.status.vars),
    stats: st.stats.length ? st.stats.map((l) => t(l.key, l.vars)).join(" · ") : null,
  };
}

function PlayToast({
  flow,
  tv,
  live,
  onDismiss,
  onAnother,
}: {
  flow: Exclude<PlayFlow, { step: "idle" | "picking" | "player" | "confirm" }>;
  tv: string;
  live: LiveState | undefined;
  onDismiss: () => void;
  onAnother: (target: PlayTarget) => void;
}) {
  const { t } = useI18n();
  const done = flow.step === "done" ? flow : null;
  const sent = done?.outcome.kind === "sent";
  const queued = done?.outcome.kind === "queued";
  const failed = done?.outcome.kind === "error" ? done.outcome : null;

  // Follow the TV: its device state says searching / loading x% / playing / failed.
  const [seen, setSeen] = useState(false);
  // Never back on the phone (per request: a new play starts at 0).
  const peak = useRef<{ req: unknown; v: TvPeak }>({ req: null, v: { pct: 0, buffered: 0 } });
  if (peak.current.req !== flow.req) peak.current = { req: flow.req, v: { pct: 0, buffered: 0 } };
  const progress = holdTvProgress(tvProgress(flow.req, sent ? live?.state : null, seen), peak.current.v);
  if (!seen && (progress.kind === "searching" || progress.kind === "loading" || progress.kind === "playing")) setSeen(true);
  const offline = sent && live?.online === false;
  const tvFailed = sent && progress.kind === "failed" ? progress.code : null;
  const finished = sent && !offline && (progress.kind === "playing" || progress.kind === "gone");
  const lines = useTvLoadLines(progress);

  // Auto-hide once it plays (or the TV moved on); keep failures and in-progress states visible.
  useEffect(() => {
    if (!finished && !queued) return;
    const timer = setTimeout(onDismiss, progress.kind === "gone" ? 1500 : 6000);
    return () => clearTimeout(timer);
  }, [finished, queued, progress.kind, onDismiss]);

  let line: string;
  if (failed) line = errorMessage(failed.code, t);
  else if (flow.step === "sending") line = t("player.opening_on", { tv });
  else if (queued) line = t("player.queued", { tv });
  else if (offline) line = t("remote.error.device_offline");
  else if (tvFailed) line = t("player.tv_failed", { tv, reason: sourceErrorMessage(tvFailed, t) });
  else if (progress.kind === "searching") line = t("player.tv_searching", { tv });
  else if (progress.kind === "loading") line = t("player.tv_loading", { tv, pct: progress.pct });
  else if (finished) line = t("player.playing_on", { tv });
  else line = t("player.opening_on", { tv });

  const anotherTarget: PlayTarget = { ...flow.req };
  const bad = !!failed || !!tvFailed || offline;
  const tone = bad ? "error" : finished || queued ? "ok" : "busy";
  const outcomeAttr = failed ? failed.code : tvFailed ? `tv_${tvFailed}` : done?.outcome.kind;
  const pct = progress.kind === "loading" ? progress.pct : null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-30 flex justify-center px-3 md:bottom-6">
      <div
        role={tone === "error" ? "alert" : "status"}
        data-testid="play-progress"
        data-step={flow.step}
        data-outcome={outcomeAttr}
        data-tv={sent ? progress.kind : undefined}
        className={`pointer-events-auto w-full max-w-md rounded-2xl border bg-surface/95 p-3 shadow-2xl shadow-black/50 backdrop-blur ${
          tone === "error" ? "border-danger/40" : tone === "ok" ? "border-ok/30" : "border-border"
        }`}
      >
        <div className="flex items-start gap-3">
          <span
            className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-lg ${
              tone === "error" ? "bg-danger/15 text-danger" : tone === "ok" ? "bg-ok/15 text-ok" : "bg-accent/15 text-accent"
            }`}
          >
            {tone === "error" ? <AlertIcon /> : tone === "ok" ? <CheckIcon /> : <Spinner size={16} />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{flow.req.label}</p>
            <p className="text-sm text-text/85" data-testid="play-progress-line">
              {line}
            </p>
            {!bad && lines.stage && (
              <p className="text-xs text-text/70" data-testid="play-progress-stage">
                {lines.stage}
              </p>
            )}
            {!bad && lines.stats && (
              <p className="text-xs tabular-nums text-accent" data-testid="play-progress-stats">
                {lines.stats}
              </p>
            )}
            {pct !== null && !bad && (
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border" aria-hidden>
                <div className="h-full origin-left rounded-full bg-accent transition-transform duration-500" style={{ transform: `scaleX(${pct / 100})` }} />
              </div>
            )}
            {progress.kind === "loading" && progress.release && !bad && <p className="mt-0.5 truncate text-xs text-muted">{progress.release}</p>}
          </div>
          {flow.step === "done" && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label={t("common.close")}
              className="-mr-1 -mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted hover:text-text"
            >
              <CloseIcon />
            </button>
          )}
        </div>
        {(sent || queued) && (
          <div className="mt-2 flex flex-wrap justify-end gap-1 border-t border-border pt-2">
            {/* Also while the TV still prepares: another release replaces it there (no «interrupt?» question). */}
            {sent && !finished && (
              <button
                type="button"
                onClick={() => onAnother(anotherTarget)}
                data-testid="play-another"
                className="flex min-h-[40px] items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-text hover:bg-surface-2"
              >
                <ListIcon />
                {t("player.another_release")}
              </button>
            )}
            {done && (
              <Link
                to={`/remote/${done.deviceId}`}
                className="flex min-h-[40px] items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-accent hover:bg-surface-2"
                data-testid="play-remote-link"
              >
                <RemoteIcon />
                {t("remote.remote")}
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

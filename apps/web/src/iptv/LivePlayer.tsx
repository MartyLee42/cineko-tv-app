// In-browser live player (overlay over the «ТВ» page). Live mode: no seek
// bar beyond the live window, «В эфир» jumps to the live edge, channel
// up/down and number keys switch channels, an OSD shows now/next.
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { IptvChannel, PlaybackSource } from "@martytv/contracts";
import { apiErrorCode, hasMediaSource, liveCodecProblem, liveFailureFromCode, mseTypeSupported, type LiveFailure } from "@martytv/media-types";
import { reportError, Spinner, useI18n } from "@martytv/ui";
import { AlertIcon, CastIcon, ChevronLeft, CloseIcon, FullscreenIcon, ListIcon, MuteIcon, PauseIcon, PlayIcon, VolumeIcon } from "../icons";
import { enterFullscreen, exitFullscreen, fullscreenElement } from "../player/media";
import { useActiveProfile } from "../watch/ActiveProfile";
import { attachLive, attachLiveTs, type LiveHandle } from "./livehls";
import { BEHIND_LIVE_SECONDS, channelByNumber, formatLag, liveLag, neighbour, typeDigit } from "./logic";
import { createLiveSource, reportWatched } from "./queries";
import { useSendChannel } from "./SendChannel";
import { ChannelLogo, NowNext, useNow } from "./ui";

type Status = { kind: "loading" } | { kind: "ready"; url: string; ts: boolean } | { kind: "error"; failure: LiveFailure; codec?: string };
/** A status for one channel/attempt (a newer key means "loading"). */
type Keyed = { key: string; status: Status };

const WATCHED_AFTER_MS = 5000;
const OSD_MS = 4000;

export function LivePlayer({
  channels,
  channelId,
  onChannel,
  onClose,
}: {
  channels: IptvChannel[];
  channelId: string;
  onChannel: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { profileId } = useActiveProfile();
  const { send } = useSendChannel();
  const now = useNow(15_000);
  const channel = channels.find((c) => c.id === channelId) ?? null;

  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const handle = useRef<LiveHandle | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${channelId}|${attempt}`;
  const [keyed, setKeyed] = useState<Keyed>({ key: "", status: { kind: "loading" } });
  const status: Status = keyed.key === key ? keyed.status : { kind: "loading" };
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [muted, setMuted] = useState(false);
  const [lag, setLag] = useState(0);
  const [range, setRange] = useState<{ start: number; end: number; pos: number } | null>(null);
  const [osd, setOsd] = useState(true);
  const [list, setList] = useState(false);
  const [digits, setDigits] = useState("");

  // ---- source: a fresh token per channel; one silent re-POST on a fatal
  // error (the server then tries the channel's mirrors and names the cause).
  const retried = useRef(false);
  const toStatus = useCallback((src: PlaybackSource): Status => {
    const ts = src.format === "ts";
    if (!src.stream_url) return { kind: "error", failure: "broken" };
    const el = video.current;
    const native = ts ? el?.canPlayType("video/mp2t") : "";
    if (ts && !hasMediaSource() && !native) return { kind: "error", failure: "format" };
    // Through MSE (hls.js / mpegts.js) the browser must decode the codecs itself.
    const codec = native ? null : liveCodecProblem(src, mseTypeSupported());
    if (codec) return { kind: "error", failure: "codec", codec };
    return { kind: "ready", url: src.stream_url, ts };
  }, []);
  const failed = useCallback((e: unknown): Status => ({ kind: "error", failure: liveFailureFromCode(apiErrorCode(e)) }), []);
  useEffect(() => {
    retried.current = false;
    let cancelled = false;
    const set = (s: Status) => !cancelled && setKeyed({ key, status: s });
    createLiveSource(channelId, profileId).then(
      (src) => set(toStatus(src)),
      (e) => set(failed(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [key, channelId, profileId, toStatus, failed]);

  const onFatal = useCallback(() => {
    const set = (s: Status) => setKeyed({ key, status: s });
    if (retried.current) {
      set({ kind: "error", failure: "broken" });
      return;
    }
    retried.current = true;
    createLiveSource(channelId, profileId).then(
      (src) => set(toStatus(src)),
      (e) => set(failed(e)),
    );
  }, [key, channelId, profileId, toStatus, failed]);

  // A failure goes to Admin → Errors with its cause (API failures are reported by the client middleware).
  const failure = status.kind === "error" ? status : null;
  useEffect(() => {
    if (!failure || failure.failure === "geo" || failure.failure === "offline" || failure.failure === "timeout") return;
    reportError("player", `live: ${failure.failure}${failure.codec ? ` (${failure.codec})` : ""}`, { component: "live", extra: { channel: channel?.name } });
  }, [failure, channel?.name]);

  const url = status.kind === "ready" ? status.url : null;
  const ts = status.kind === "ready" && status.ts;
  useEffect(() => {
    const el = video.current;
    if (!el || !url) return;
    let h: LiveHandle | null = null;
    let gone = false;
    void (ts ? attachLiveTs(el, url, onFatal) : attachLive(el, url, onFatal)).then((x) => {
      if (gone) x.destroy();
      else {
        h = x;
        handle.current = x;
        el.play().catch(() => {
          // Autoplay with sound blocked: start muted, offer unmute.
          el.muted = true;
          setMuted(true);
          void el.play().catch(() => {});
        });
      }
    });
    return () => {
      gone = true;
      h?.destroy();
      handle.current = null;
    };
  }, [url, ts, onFatal]);

  // ---- "watched channel" event after a few seconds of playback.
  useEffect(() => {
    if (!playing || !profileId) return;
    const id = setTimeout(() => {
      reportWatched(channelId, profileId).then(
        () => qc.invalidateQueries({ queryKey: ["iptv", "state"] }),
        () => {},
      );
    }, WATCHED_AFTER_MS);
    return () => clearTimeout(id);
    // Once per channel: `playing` flapping on rebuffers restarts the timer, which is fine.
  }, [playing, channelId, profileId, qc]);

  // ---- live position / window.
  useEffect(() => {
    const id = setInterval(() => {
      const el = video.current;
      if (!el) return;
      const edge = handle.current?.liveEdge() ?? null;
      setLag(liveLag(el.currentTime, edge));
      if (el.seekable.length) {
        const start = el.seekable.start(0);
        const end = el.seekable.end(el.seekable.length - 1);
        setRange(end - start >= 30 ? { start, end, pos: el.currentTime } : null);
      } else setRange(null);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ---- OSD: visible on changes, hides after a few seconds while playing.
  const poke = useCallback(() => setOsd(true), []);
  useEffect(() => {
    if (!osd || !playing || list) return;
    const id = setTimeout(() => setOsd(false), OSD_MS);
    return () => clearTimeout(id);
  }, [osd, playing, list, channelId]);

  /** Switches channel and shows the OSD for the new one. */
  const change = useCallback(
    (id: string) => {
      setOsd(true);
      onChannel(id);
    },
    [onChannel],
  );
  const zap = useCallback(
    (dir: 1 | -1) => {
      const next = neighbour(channels, channelId, dir);
      if (next && next.id !== channelId) change(next.id);
    },
    [channels, channelId, change],
  );

  // Number entry: digits collect for 1.5 s, then jump.
  useEffect(() => {
    if (!digits) return;
    const id = setTimeout(() => {
      const c = channelByNumber(channels, digits);
      if (c) change(c.id);
      setDigits("");
    }, 1500);
    return () => clearTimeout(id);
  }, [digits, channels, change]);

  const togglePlay = () => {
    const el = video.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  };
  const toggleMute = () => {
    const el = video.current;
    if (!el) return;
    el.muted = !el.muted;
    setMuted(el.muted);
  };
  const goLive = () => {
    const el = video.current;
    const edge = handle.current?.liveEdge();
    if (el && edge != null) el.currentTime = Math.max(0, edge - 1);
    if (el?.paused) void el.play().catch(() => {});
    poke();
  };
  const toggleFs = async () => {
    if (fullscreenElement()) await exitFullscreen();
    else if (box.current && video.current) await enterFullscreen(box.current, video.current);
  };

  // Keyboard: Up/PageUp = next number, Down/PageDown = previous, digits, Space, M, F, Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      poke();
      switch (e.key) {
        case "ArrowUp":
        case "PageUp":
        case "ChannelUp":
          e.preventDefault();
          zap(1);
          return;
        case "ArrowDown":
        case "PageDown":
        case "ChannelDown":
          e.preventDefault();
          zap(-1);
          return;
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          return;
        case "m":
          toggleMute();
          return;
        case "f":
          void toggleFs();
          return;
        case "Escape":
          if (list) setList(false);
          else if (!fullscreenElement()) onClose();
          return;
      }
      if (/^\d$/.test(e.key)) setDigits((d) => typeDigit(d, e.key));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => () => void exitFullscreen(), []);

  const behind = lag > BEHIND_LIVE_SECONDS;
  const visible = osd || !playing || status.kind !== "ready";

  return (
    <div
      ref={box}
      className="fixed inset-0 z-50 flex select-none flex-col bg-black text-white"
      data-testid="live-player"
      data-channel-id={channelId}
      onMouseMove={poke}
    >
      <video
        ref={video}
        data-testid="live-video"
        className="absolute inset-0 h-full w-full bg-black object-contain"
        playsInline
        onPlaying={() => {
          setPlaying(true);
          setBuffering(false);
        }}
        onPause={() => setPlaying(false)}
        onWaiting={() => setBuffering(true)}
        onEmptied={() => {
          setBuffering(true);
          setPlaying(false);
        }}
        onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
      />

      {(status.kind === "loading" || (status.kind === "ready" && buffering)) && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3" data-testid="live-loading">
          <Spinner size={40} />
          <p className="text-sm text-white/80">{t("iptv.web.connecting")}</p>
        </div>
      )}

      {status.kind === "error" && (
        <div className="absolute inset-0 flex items-center justify-center p-6" data-testid="live-error" data-cause={status.failure}>
          <div className="max-w-sm space-y-4 rounded-2xl bg-white/10 p-5 text-center backdrop-blur">
            <AlertIcon className="mx-auto text-3xl text-white/80" />
            <p className="font-semibold text-white/90">{t(`iptvplay.err.${status.failure}`, { codec: status.codec ?? "" })}</p>
            <p className="text-sm text-white/70">{t(status.failure === "codec" ? "iptvplay.hint.codec" : "iptvplay.hint.other")}</p>
            <div className="flex flex-wrap justify-center gap-2">
              {status.failure !== "codec" && (
                <button type="button" onClick={() => setAttempt((n) => n + 1)} className="min-h-[44px] rounded-xl bg-white/15 px-4 font-semibold hover:bg-white/25">
                  {t("iptvplay.retry")}
                </button>
              )}
              <button
                type="button"
                onClick={() => send(channelId)}
                data-testid="live-send-to-tv"
                className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-accent px-4 font-semibold text-on-accent hover:bg-accent-strong"
              >
                <CastIcon /> {t("iptv.web.play_on_tv")}
              </button>
            </div>
          </div>
        </div>
      )}

      {digits && (
        <div className="absolute right-6 top-20 rounded-xl bg-black/70 px-4 py-2 font-mono text-4xl font-bold tabular-nums" data-testid="live-digits">
          {digits}
        </div>
      )}

      {/* Top bar */}
      <div
        className={`relative flex items-center gap-3 bg-gradient-to-b from-black/80 to-transparent px-3 pb-8 pt-[calc(0.75rem+env(safe-area-inset-top))] transition-opacity sm:px-5 ${visible ? "opacity-100" : "pointer-events-none opacity-0"}`}
      >
        <button type="button" onClick={onClose} aria-label={t("iptv.web.close_player")} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-2xl hover:bg-white/15" data-testid="live-close">
          <ChevronLeft />
        </button>
        {channel && <ChannelLogo channel={channel} size={40} />}
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold" data-testid="live-channel-name">
            <span className="mr-2 tabular-nums text-white/60">{channel?.number}</span>
            {channel?.name}
          </p>
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-red-400">
            <span className="h-2 w-2 rounded-full bg-red-500" aria-hidden /> {t("iptv.live")}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setList((v) => !v)}
          aria-label={t("iptv.web.channel_list")}
          aria-pressed={list}
          data-testid="live-list-toggle"
          className="flex h-11 w-11 items-center justify-center rounded-full text-xl hover:bg-white/15"
        >
          <ListIcon />
        </button>
        <button type="button" onClick={() => send(channelId)} aria-label={t("iptv.web.play_on_tv")} className="flex h-11 w-11 items-center justify-center rounded-full text-xl hover:bg-white/15">
          <CastIcon />
        </button>
      </div>

      <div className="relative flex-1" onClick={() => (osd ? togglePlay() : poke())} data-testid="live-surface" />

      {/* Bottom OSD: now/next, live window, controls */}
      <div
        className={`relative space-y-3 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-10 transition-opacity sm:px-6 ${visible ? "opacity-100" : "pointer-events-none opacity-0"}`}
        data-testid="live-osd"
      >
        {channel && (
          <div className="max-w-2xl [&_.text-muted]:text-white/70">
            <NowNext now={channel.now} next={channel.next} at={now} />
          </div>
        )}
        {range && (
          <input
            type="range"
            aria-label={t("iptv.live")}
            data-testid="live-window"
            min={range.start}
            max={range.end}
            step={1}
            value={Math.min(range.end, Math.max(range.start, range.pos))}
            onChange={(e) => {
              const el = video.current;
              if (el) el.currentTime = Number(e.target.value);
            }}
            className="w-full accent-accent"
          />
        )}
        <div className="flex items-center gap-1 sm:gap-2">
          <IconBtn label={t("iptv.web.prev_channel")} onClick={() => zap(-1)} testId="live-prev">
            <ChevronLeft className="-rotate-90" />
          </IconBtn>
          <IconBtn label={playing ? t("iptv.web.pause") : t("iptv.web.play")} onClick={togglePlay} testId="live-playpause">
            {playing ? <PauseIcon /> : <PlayIcon />}
          </IconBtn>
          <IconBtn label={t("iptv.web.next_channel")} onClick={() => zap(1)} testId="live-next">
            <ChevronLeft className="rotate-90" />
          </IconBtn>
          <IconBtn label={muted ? t("iptv.web.unmute") : t("iptv.web.mute")} onClick={toggleMute} testId="live-mute">
            {muted ? <MuteIcon /> : <VolumeIcon />}
          </IconBtn>
          <button
            type="button"
            onClick={goLive}
            data-testid="live-go-live"
            data-behind={behind}
            className={`ml-auto inline-flex min-h-[40px] items-center gap-2 rounded-full px-4 text-sm font-semibold transition ${
              behind ? "bg-red-600 text-white hover:bg-red-500" : "bg-white/10 text-white/70"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${behind ? "bg-white" : "bg-red-500"}`} aria-hidden />
            {t("iptv.go_live")}
            {behind && <span className="tabular-nums text-white/85">−{formatLag(lag)}</span>}
          </button>
          <IconBtn label={t("iptv.web.fullscreen")} onClick={() => void toggleFs()}>
            <FullscreenIcon />
          </IconBtn>
        </div>
      </div>

      {list && (
        <aside className="absolute inset-y-0 right-0 z-10 flex w-full max-w-sm flex-col bg-black/90 backdrop-blur" data-testid="live-channel-list">
          <div className="flex items-center justify-between px-4 pb-2 pt-[calc(0.75rem+env(safe-area-inset-top))]">
            <h2 className="font-semibold">{t("iptv.channels")}</h2>
            <button type="button" onClick={() => setList(false)} aria-label={t("common.close")} className="flex h-11 w-11 items-center justify-center rounded-full text-xl hover:bg-white/15">
              <CloseIcon />
            </button>
          </div>
          <ul className="flex-1 overflow-y-auto overscroll-contain px-2 pb-4">
            {channels.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => {
                    change(c.id);
                    setList(false);
                  }}
                  aria-current={c.id === channelId}
                  className={`flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-white/10 ${c.id === channelId ? "bg-white/15" : ""} ${c.offline ? "opacity-50" : ""}`}
                >
                  <span className="w-8 shrink-0 text-right text-sm tabular-nums text-white/60">{c.number}</span>
                  <ChannelLogo channel={c} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{c.name}</span>
                    <span className="block truncate text-xs text-white/60">{c.now?.title ?? ""}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}

function IconBtn({ label, onClick, children, testId }: { label: string; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} data-testid={testId} className="flex h-11 w-11 items-center justify-center rounded-full text-2xl hover:bg-white/15">
      {children}
    </button>
  );
}

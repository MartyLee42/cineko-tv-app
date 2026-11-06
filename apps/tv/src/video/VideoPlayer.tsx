// Full-screen «Видео» player. The source is POST /playback/sources {kind:
// video}: an fMP4 HLS stream through the API's signed proxy (natively or
// through hls.js), else — or when HLS fails — the progressive 360p MP4
// fallback for old engines. Keys like the film player: OK pauses (or
// commits a pending seek), ◀▶ seek (accelerating), ▲▼ open the panel
// (quality chips + related videos); Back cancels a pending seek, closes the
// panel, folds the pause overlay, else leaves. Phones control it through
// media.pause/resume/seek/stop/next_episode and video.play (quality); the
// player reports its state for DeviceState.video. Progress is reported every
// ~10 s, on pause and on exit.
import { useCallback, useEffect, useRef, useState } from "react";
import { pause as pauseNav, resume as resumeNav } from "@noriginmedia/norigin-spatial-navigation";
import { ApiError, type PlaybackSource } from "@martytv/contracts";
import { Spinner, useI18n } from "@martytv/ui";
import { useDesign, type Design } from "../design/context";
import { accumulateSeek, playerKey, registerMediaKeys, type SeekPreview } from "../player/keys";
import { attachHlsJs, streamMode, type HlsHandle } from "../player/stream";
import { formatClock } from "../player/format";
import { tvVolume } from "../player/volume";
import { claimKeys } from "../remote/keyOwner";
import { useSettings } from "../profile/settings";
import {
  blockReason,
  nextRelated,
  pickPlay,
  profileQuality,
  PROGRESS_EVERY,
  qualityList,
  reportable,
  startPosition,
  type PlayMode,
  type VideoFailure,
  type VideoDetail,
  type VideoItem,
  type VideoQuality,
} from "./logic";
import { createVideoSource, invalidateVideoLists, isVideoUnavailable, reportVideoProgress, useVideoDetail } from "./queries";
import { useVideoSession, videoSession, type VideoSession } from "./session";
import { useVideoMeta, VideoThumb } from "./VideoCard";

const OSD_MS = 4000;
/** Seek presses are collected this long before the jump. */
const SEEK_COMMIT = 650;
const PANEL_CARDS = 5;
const CARD = { w: 320, h: 180 };
const CARD_PITCH = 352;

type Phase = "loading" | "playing" | "error";
type Failure = VideoFailure;
type Panel = { line: "quality" | "related"; idx: number };

export function VideoPlayer() {
  const session = useVideoSession();
  if (!session) return null;
  return <VideoInner session={session} />;
}

function VideoInner({ session }: { session: VideoSession }) {
  const { t } = useI18n();
  const design = useDesign();
  const settings = useSettings();
  const id = session.video.id;
  const detail = useVideoDetail(id);
  const d: VideoDetail | undefined = detail.data;
  const title = d?.title ?? session.video.title ?? "";
  const quality: VideoQuality = session.quality ?? profileQuality(settings.video_quality);
  const related = d?.related ?? [];
  const qualities = qualityList(d?.qualities);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [paused, setPaused] = useState(false);
  const [mode, setMode] = useState<PlayMode | null>(null);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState<number | null>(session.video.duration_seconds ?? null);
  const [osd, setOsd] = useState(true);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [seek, setSeek] = useState<SeekPreview | null>(null);
  /** Paused with the overlay folded by Back (to look at the frame); the next Back leaves. */
  const [hush, setHush] = useState(false);
  const osdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Where a reload (quality switch) continues. */
  const resumeFrom = useRef<number | null>(null);
  const [reload, setReload] = useState(0);
  // A quality picked in the panel holds for this session; a new video starts from the session's / profile's.
  const [picked, setPicked] = useState<{ seq: number; q: VideoQuality } | null>(null);
  const cap: VideoQuality = picked && picked.seq === session.seq ? picked.q : quality;

  const showOsd = useCallback(() => {
    setOsd(true);
    clearTimeout(osdTimer.current);
    osdTimer.current = setTimeout(() => setOsd(false), OSD_MS);
  }, []);
  useEffect(
    () => () => {
      clearTimeout(osdTimer.current);
      clearTimeout(seekTimer.current);
    },
    [],
  );
  // Every new video shows the OSD and closes the panel (adjusted during render), hidden again after OSD_MS.
  const [seenSeq, setSeenSeq] = useState(session.seq);
  if (seenSeq !== session.seq) {
    setSeenSeq(session.seq);
    setOsd(true);
    setPanel(null);
    setHush(false);
  }
  useEffect(() => {
    clearTimeout(osdTimer.current);
    osdTimer.current = setTimeout(() => setOsd(false), OSD_MS);
  }, [session.seq]);

  // ---- the stream: a fresh source per video / quality; HLS failing → the MP4 fallback.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let cancelled = false;
    let hls: HlsHandle | null = null;
    let src: PlaybackSource | null = null;
    let current: PlayMode | null = null;
    let startAt = 0;
    let lastReport: number | null = null;
    setPhase("loading");
    setFailure(null);

    const reset = () => {
      hls?.destroy();
      hls = null;
      v.removeAttribute("src");
      try {
        v.load();
      } catch {
        // ignore
      }
    };
    const fail = (f: Failure) => {
      if (cancelled) return;
      reset();
      setFailure(f);
      setPhase("error");
    };
    const attach = async (hlsFailed: boolean) => {
      if (!src) return;
      const choice = pickPlay(src, streamMode({ format: src.format ?? "hls", mime_type: src.mime_type }, v), hlsFailed);
      if (!choice) return fail("unplayable");
      current = choice.mode;
      setMode(choice.mode);
      if (choice.mode === "hls-js") {
        const h = await attachHlsJs(v, choice.url, () => {
          if (cancelled) return;
          // HLS gave up: the progressive fallback from where we are.
          startAt = v.currentTime > 1 ? v.currentTime : startAt;
          reset();
          void attach(true);
        }).catch(() => null);
        if (cancelled) return h?.destroy();
        if (!h) return attach(true);
        hls = h;
      } else {
        v.src = choice.url;
      }
      void v.play().catch(() => undefined);
    };
    const start = async () => {
      try {
        src = await createVideoSource(id, cap);
      } catch (e) {
        if (cancelled) return;
        if (isVideoUnavailable(e)) return fail("unavailable");
        if (e instanceof ApiError && e.code === "video_live_unsupported") return fail("live");
        if (e instanceof ApiError && e.status === 422) return fail("unplayable");
        return fail("failed");
      }
      if (cancelled) return;
      const resume = resumeFrom.current;
      resumeFrom.current = null;
      startAt = resume ?? startPosition(session.start, src.position_seconds, src.duration_seconds ?? session.video.duration_seconds);
      await attach(false);
    };

    const report = () => {
      const p = v.currentTime;
      const du = isFinite(v.duration) ? v.duration : null;
      if (!reportable(p, du) || p === lastReport) return;
      lastReport = p;
      void reportVideoProgress(id, p, du);
    };
    const onMeta = () => {
      if (isFinite(v.duration)) setDur(v.duration);
      if (startAt > 0 && Math.abs(v.currentTime - startAt) > 2) {
        try {
          v.currentTime = startAt;
        } catch {
          // ignore
        }
      }
    };
    const onPlaying = () => {
      if (cancelled) return;
      setPhase("playing");
      setPaused(false);
      setHush(false);
    };
    const onPause = () => {
      if (cancelled) return;
      setPaused(true);
      setOsd(true);
      clearTimeout(osdTimer.current);
      report();
    };
    const onWaiting = () => !cancelled && setPhase((p) => (p === "error" ? p : "loading"));
    // The phone's remote follows at once (play/pause/seek/buffering/volume).
    const onChange = () => !cancelled && videoSession.changed();
    const NOTIFY = ["play", "pause", "playing", "waiting", "seeked", "volumechange", "durationchange", "loadedmetadata"] as const;
    const onTime = () => !cancelled && setPos(v.currentTime);
    const onEnded = () => {
      report();
      setOsd(true);
      setPanel((p) => p ?? { line: "related", idx: 0 });
    };
    const onError = () => {
      if (cancelled || !src) return;
      // The engine rejected the HLS stream: try the MP4 fallback once.
      if (current !== "mp4" && src.fallback_url) {
        startAt = v.currentTime > 1 ? v.currentTime : startAt;
        reset();
        void attach(true);
        return;
      }
      fail("failed");
    };
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("playing", onPlaying);
    v.addEventListener("pause", onPause);
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("ended", onEnded);
    v.addEventListener("error", onError);
    for (const ev of NOTIFY) v.addEventListener(ev, onChange);
    const tick = setInterval(() => {
      if (!v.paused && !v.ended) report();
    }, PROGRESS_EVERY);
    void start();
    return () => {
      cancelled = true;
      clearInterval(tick);
      report();
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("playing", onPlaying);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("ended", onEnded);
      v.removeEventListener("error", onError);
      for (const ev of NOTIFY) v.removeEventListener(ev, onChange);
      reset();
      invalidateVideoLists();
    };
    // session.start / duration are read once per (video, quality, reload).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, session.seq, cap, reload]);

  // The TV's saved level (playback.set_volume) applies here too.
  useEffect(() => {
    const v = videoRef.current;
    return v ? tvVolume.bind(v) : undefined;
  }, []);

  // ---- controls (also for remote media.pause/resume/seek)
  const togglePause = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
    showOsd();
  }, [showOsd]);
  const switchQuality = useCallback(
    (q: VideoQuality) => {
      const v = videoRef.current;
      if (q === cap) return;
      resumeFrom.current = v && v.currentTime > 1 ? v.currentTime : null;
      setPicked({ seq: session.seq, q });
      setReload((n) => n + 1);
    },
    [cap, session.seq],
  );
  const play = useCallback((v: VideoItem) => videoSession.open(v, { quality: cap }), [cap]);

  const block = d ? blockReason(d) : null;
  const shownFailure: Failure | null = failure ?? (block === "live" ? "live" : null);
  const channelName = d?.channel.name ?? session.video.channel_name ?? "";
  const st = useRef({ panel, related, qualities, cap, seek, dur, phase, failure: shownFailure, paused, osd, hush, title, channelName, channelId: d?.channel_id ?? session.video.channel_id ?? null });
  useEffect(() => {
    st.current = { panel, related, qualities, cap, seek, dur, phase, failure: shownFailure, paused, osd, hush, title, channelName, channelId: d?.channel_id ?? session.video.channel_id ?? null };
  });
  // Title / channel / quality / phase changes reach the phone at once.
  useEffect(() => videoSession.changed(), [title, channelName, cap, phase, shownFailure, qualities.length]);
  useEffect(() => {
    videoSession.setControls({
      pause: () => {
        const v = videoRef.current;
        if (!v || st.current.failure) return false;
        v.pause();
        return true;
      },
      resume: () => {
        const v = videoRef.current;
        if (!v || st.current.failure) return false;
        void v.play().catch(() => undefined);
        showOsd();
        return true;
      },
      seek: (p) => {
        const v = videoRef.current;
        if (!v || !isFinite(p) || st.current.failure) return false;
        const du = isFinite(v.duration) ? v.duration : st.current.dur;
        v.currentTime = du && du > 1 ? Math.min(Math.max(0, p), du - 1) : Math.max(0, p);
        showOsd();
        return true;
      },
      next: () => {
        const n = nextRelated(st.current.related, id);
        if (!n) return false;
        play(n);
        return true;
      },
      quality: (q) => {
        if (st.current.failure) return false;
        switchQuality(q);
        showOsd();
        return true;
      },
      info: () => {
        const v = videoRef.current;
        const c = st.current;
        return {
          title: c.title || null,
          channel_id: c.channelId,
          channel_name: c.channelName || null,
          position: v?.currentTime ?? 0,
          duration: v && isFinite(v.duration) ? v.duration : c.dur,
          paused: v?.paused ?? true,
          buffering: !c.failure && c.phase === "loading",
          quality: c.cap,
          qualities: c.qualities,
          volume: v ? v.volume : null,
          error: c.failure,
        };
      },
    });
    return () => videoSession.setControls(null);
  }, [id, play, switchQuality, showOsd]);

  useEffect(() => {
    pauseNav();
    const claim = claimKeys();
    const unregister = registerMediaKeys();
    const commitSeek = () => {
      clearTimeout(seekTimer.current);
      const target = st.current.seek?.target;
      st.current.seek = null;
      setSeek(null);
      if (target !== undefined && videoRef.current) videoRef.current.currentTime = target;
      showOsd();
    };
    const doSeek = (dir: -1 | 1) => {
      const v = videoRef.current;
      if (!v) return;
      const prev = st.current.seek;
      const next = accumulateSeek(prev, v.currentTime, dir, isFinite(v.duration) ? v.duration : st.current.dur);
      st.current.seek = next;
      setSeek(next);
      setHush(false);
      setOsd(true);
      clearTimeout(osdTimer.current);
      clearTimeout(seekTimer.current);
      seekTimer.current = setTimeout(commitSeek, SEEK_COMMIT);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!claim.top) return;
      const k = playerKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const { panel, related, qualities, cap, failure } = st.current;
      if (failure) {
        if ((k === "back" || k === "stop" || k === "ok") && !e.repeat) videoSession.close();
        return;
      }
      if (panel) {
        const items = panel.line === "related" ? related.length : qualities.length;
        if (k === "left") setPanel({ ...panel, idx: Math.max(0, panel.idx - 1) });
        else if (k === "right") setPanel({ ...panel, idx: Math.min(Math.max(0, items - 1), panel.idx + 1) });
        else if (k === "up" && panel.line === "related" && qualities.length > 1) setPanel({ line: "quality", idx: Math.max(0, qualities.indexOf(cap)) });
        else if (k === "down" && panel.line === "quality" && related.length > 0) setPanel({ line: "related", idx: 0 });
        else if (k === "down" && panel.line === "related") setPanel(null);
        else if (k === "ok" && !e.repeat) {
          if (panel.line === "related") {
            const v = related[panel.idx];
            if (v && !blockReason(v)) {
              setPanel(null);
              play(v);
            }
          } else {
            const q = qualities[panel.idx];
            setPanel(null);
            if (q) switchQuality(q as VideoQuality);
          }
        } else if (k === "back") {
          setPanel(null);
          // Paused: the panel goes away without the pause overlay coming back (the next Back leaves).
          if (videoRef.current?.paused) setHush(true);
        } else if (k === "playpause" || k === "play" || k === "pause") togglePause();
        else if (k === "stop") videoSession.close();
        return;
      }
      switch (k) {
        case "ok":
        case "playpause":
          if (e.repeat) return;
          // A pending seek: OK jumps there now.
          if (st.current.seek) return commitSeek();
          return togglePause();
        case "play":
          void videoRef.current?.play().catch(() => undefined);
          return showOsd();
        case "pause":
          videoRef.current?.pause();
          return;
        case "left":
        case "rew":
          return doSeek(-1);
        case "right":
        case "ff":
          return doSeek(1);
        case "up":
        case "down":
        case "chup":
        case "chdown":
          if (related.length > 0) return setPanel({ line: "related", idx: 0 });
          if (qualities.length > 1) return setPanel({ line: "quality", idx: Math.max(0, qualities.indexOf(cap)) });
          return showOsd();
        case "next": {
          const v = related.find((x) => !blockReason(x));
          if (v) play(v);
          return;
        }
        case "back": {
          // Like the film player: a pending seek is cancelled; paused, the
          // first Back folds the pause overlay, the next one leaves.
          if (st.current.seek) {
            clearTimeout(seekTimer.current);
            st.current.seek = null;
            setSeek(null);
            return showOsd();
          }
          if (e.repeat) return;
          const v = videoRef.current;
          if (v?.paused && !v.ended && !st.current.hush) {
            setOsd(false);
            return setHush(true);
          }
          return videoSession.close();
        }
        case "stop":
          return videoSession.close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      claim.release();
      unregister();
      resumeNav();
    };
  }, [togglePause, switchQuality, play, showOsd]);

  const visible = (osd || paused || !!seek || !!panel) && !(hush && !seek && !panel);
  return (
    <div data-testid="video-player" data-video-id={id} data-phase={phase} data-mode={mode ?? ""} data-quality={cap} data-paused={paused ? "1" : "0"} className="absolute left-0 top-0 h-[1080px] w-[1920px] overflow-hidden bg-black">
      <video ref={videoRef} className="absolute left-0 top-0 h-full w-full" style={{ objectFit: "contain" }} preload="auto" playsInline autoPlay />
      {phase === "loading" && !shownFailure && (
        <div className="absolute left-0 top-0 flex h-full w-full items-center justify-center">
          <Spinner size={88} />
        </div>
      )}
      {shownFailure && <Failed design={design} title={title} failure={shownFailure} />}
      {!shownFailure && visible && (
        <Osd
          design={design}
          title={title}
          channel={channelName}
          pos={seek ? seek.target : pos}
          dur={dur}
          seeking={!!seek}
          paused={paused && !hush}
          note={mode === "mp4" ? t("video.tv.fallback") : t("video.tv.quality_note", { q: `${Math.min(cap, qualities[0] ?? cap)}p` })}
          bottom={!panel}
        />
      )}
      {!shownFailure && panel && <PanelView design={design} panel={panel} related={related} qualities={qualities} cap={cap} />}
    </div>
  );
}

// ---------------------------------------------------------------- pieces

function Osd({
  design,
  title,
  channel,
  pos,
  dur,
  seeking,
  paused,
  note,
  bottom,
}: {
  design: Design;
  title: string;
  channel: string;
  pos: number;
  dur: number | null;
  seeking: boolean;
  paused: boolean;
  note: string;
  /** The seek bar (hidden under the panel). */
  bottom: boolean;
}) {
  const { t } = useI18n();
  const terminal = design === "terminal";
  const frac = dur && dur > 0 ? Math.max(0, Math.min(1, pos / dur)) : 0;
  return (
    <>
      <div className="tv-scrim-top absolute left-0 top-0 h-[260px] w-full" />
      <div className="absolute left-[96px] right-[96px] top-[64px]">
        <p data-testid="video-osd-title" className={`truncate text-[46px] font-bold leading-tight text-white ${terminal ? "t-label text-[38px]" : ""}`}>
          {title}
        </p>
        <p className="mt-2 truncate text-[28px] text-white/75">{channel}</p>
      </div>
      {paused && (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <span data-testid="video-paused" className="tv-pause-badge flex h-[132px] w-[132px] items-center justify-center rounded-full text-[60px]">
            ❚❚
          </span>
        </div>
      )}
      {bottom && <div data-testid="video-osd" className="absolute bottom-0 left-0 w-full">
        <div className="tv-scrim-bottom-strong absolute bottom-0 left-0 h-[300px] w-full" />
        <div className="relative mx-[96px] mb-[60px]">
          <div className="mb-4 flex items-end text-[26px] text-white/85">
            <span data-testid="video-note">{note}</span>
            <span className="ml-auto text-[21px] text-white/70">{t("video.tv.keys_hint")}</span>
          </div>
          <div className="relative h-[10px] w-full overflow-hidden rounded-full bg-white/25">
            <span className="tv-progress-fill absolute left-0 top-0 h-full w-full" style={{ transform: `scaleX(${frac})` }} />
          </div>
          <div className={`mt-3 flex text-[28px] tabular-nums ${terminal ? "font-mono" : ""}`}>
            <span data-testid="video-pos" className={seeking ? "font-bold text-accent" : "text-white"}>
              {formatClock(pos)}
            </span>
            <span className="ml-auto text-white/75">{dur ? formatClock(dur) : "--:--"}</span>
          </div>
        </div>
      </div>}
    </>
  );
}

function PanelView({ design, panel, related, qualities, cap }: { design: Design; panel: Panel; related: VideoItem[]; qualities: number[]; cap: number }) {
  const { t } = useI18n();
  const meta = useVideoMeta();
  const terminal = design === "terminal";
  const bg = design === "projector" ? "p-bar" : terminal ? "bg-bg/95 border-t border-accent" : "bg-surface/95";
  const rIdx = panel.line === "related" ? panel.idx : -1;
  const first = Math.max(0, Math.min((rIdx < 0 ? 0 : rIdx) - 1, related.length - PANEL_CARDS));
  return (
    <div data-testid="video-panel" data-line={panel.line} className={`absolute bottom-0 left-0 w-full px-[96px] pb-[48px] pt-[28px] ${bg}`}>
      {qualities.length > 1 && (
        <div data-testid="video-qualities" className="mb-6 flex items-center">
          <span className={`mr-6 text-[24px] text-muted ${terminal ? "t-label text-[19px]" : ""}`}>{t("video.quality")}</span>
          {qualities.map((q, i) => {
            const focused = panel.line === "quality" && panel.idx === i;
            return (
              <span
                key={q}
                data-quality={q}
                className={`tv-chip mr-4 flex h-[60px] items-center px-7 text-[24px] font-semibold ${terminal ? "font-mono" : "rounded-control"} ${
                  focused ? "is-focused" : q === cap ? "bg-accent text-on-accent" : "bg-surface-2 text-text"
                }`}
              >
                {q}p
              </span>
            );
          })}
        </div>
      )}
      {related.length > 0 && (
        <>
          <div className="mb-4 flex items-end">
            <p className={`text-[28px] font-bold text-text ${terminal ? "t-label text-[22px]" : ""}`}>{t("video.related")}</p>
            <p className="ml-auto text-[21px] text-muted">{t("video.tv.panel_hint")}</p>
          </div>
          <div className="relative overflow-hidden" style={{ height: CARD.h + 92, marginLeft: -16, marginRight: -16 }}>
            <div className="tv-track absolute top-[14px]" style={{ left: 16, transform: `translate3d(${-first * CARD_PITCH}px,0,0)` }}>
              {related.map((v, i) =>
                Math.abs(i - first) > PANEL_CARDS + 1 ? null : (
                  <div key={v.id} data-related-id={v.id} className="absolute top-0" style={{ left: i * CARD_PITCH, width: CARD.w }}>
                    <VideoThumb v={v} w={CARD.w} h={CARD.h} design={design} focused={i === rIdx} />
                    <p className={`mt-3 truncate text-[21px] ${i === rIdx ? "font-bold text-text" : "text-text/80"}`}>{v.title}</p>
                    <p className="truncate text-[17px] text-muted">{[v.channel_name, meta.line(v)].filter(Boolean).join(" · ")}</p>
                  </div>
                ),
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Failed({ design, title, failure }: { design: Design; title: string; failure: Failure }) {
  const { t } = useI18n();
  const text =
    failure === "unavailable" ? t("video.unavailable") : failure === "live" ? t("video.live_unsupported") : failure === "unplayable" ? t("video.unplayable") : t("video.tv.play_failed");
  return (
    <div data-testid="video-error" data-failure={failure} className="absolute left-0 top-0 flex h-full w-full items-center justify-center">
      <div className={`tv-key-hint max-w-[1100px] px-14 py-10 text-center ${design === "terminal" ? "" : "rounded-card"}`}>
        {title && <p className="text-[40px] font-bold text-text">{title}</p>}
        <p className="mt-4 text-[30px] text-muted">{text}</p>
        <p className="mt-6 text-[24px] text-muted">{t("video.tv.error_hint")}</p>
      </div>
    </div>
  );
}

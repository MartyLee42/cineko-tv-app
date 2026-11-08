// Inline YouTube player of the watch page: native <video> controls (phones
// get their own fullscreen / PiP UI), the signed HLS proxy through hls.js (or
// native HLS on Safari/iOS), the progressive MP4 (360p) as the fallback when
// HLS fails, a quality picker, an «Аудио» picker for auto-dubbed videos
// (original / the dubs; the pick reloads from the same position and is the
// device's default for the next videos), resume and progress reports.
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, type Schemas } from "@martytv/contracts";
import { audioLabel, audioOptions, prefForTrack, Spinner, useI18n, videoAudioPref } from "@martytv/ui";
import { AlertIcon } from "../icons";
import { attachHls, type HlsHandle } from "../player/hls";
import { useActiveProfile } from "../watch/ActiveProfile";
import { formatDuration, qualityLabel, resumePosition, shouldReport } from "./logic";
import { createVideoSource, reportVideoProgress } from "./queries";

type Source = Schemas["PlaybackSource"];
type Status = { kind: "loading" } | { kind: "ready"; src: Source; mode: "hls" | "mp4" } | { kind: "error"; code: string | null };

export interface PlayerHandle {
  /** Current position (seconds) for «На ТВ». */
  position(): number;
}

/** True when the page can play HLS (hls.js with MSE, or natively). */
async function hlsPlayable(video: HTMLVideoElement): Promise<"hlsjs" | "native" | null> {
  if (video.canPlayType("application/vnd.apple.mpegurl")) return "native";
  const { loadHls } = await import("../player/hls");
  const Hls = await loadHls();
  return Hls.isSupported() ? "hlsjs" : null;
}

export function VideoPlayer({
  videoId,
  poster,
  qualities,
  startAt,
  onReady,
  onEnded,
}: {
  videoId: string;
  poster?: string;
  qualities: number[];
  /** Resume position from the detail (the source's position wins). */
  startAt?: number | null;
  onReady?: (h: PlayerHandle) => void;
  /** The video played to its end (autoplay picks the next one). */
  onEnded?: () => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const { profileId } = useActiveProfile();
  const video = useRef<HTMLVideoElement>(null);
  const [quality, setQuality] = useState<number | undefined>(undefined);
  /** The device's audio choice ("original" / a language; null = the server's default). */
  const [audio, setAudio] = useState<string | null>(() => videoAudioPref.get());
  // The status of one video/profile/quality/audio (a newer key reads as "loading").
  const key = `${videoId}|${profileId ?? ""}|${quality ?? ""}|${audio ?? ""}`;
  const [keyed, setKeyed] = useState<{ key: string; status: Status }>({ key: "", status: { kind: "loading" } });
  const status: Status = keyed.key === key ? keyed.status : { kind: "loading" };
  const setStatus = useCallback((f: (s: Status) => Status) => setKeyed((k) => ({ key, status: f(k.key === key ? k.status : { kind: "loading" }) })), [key]);
  const [resumedAt, setResumedAt] = useState(0);
  /** Where to continue after a quality switch / fallback (null = resume logic). */
  const seekTo = useRef<number | null>(null);
  const lastSent = useRef<number | null>(null);

  // ---- source: one POST per video / quality.
  useEffect(() => {
    let gone = false;
    createVideoSource(videoId, profileId, quality, audio).then(
      (src) => !gone && setStatus(() => ({ kind: "ready", src, mode: src.format === "mp4" ? "mp4" : "hls" })),
      (e: unknown) => !gone && setStatus(() => ({ kind: "error", code: e instanceof ApiError ? e.code : null })),
    );
    return () => {
      gone = true;
    };
  }, [videoId, profileId, quality, audio, setStatus]);

  const toFallback = useCallback(() => {
    setStatus((s) => {
      if (s.kind !== "ready") return s;
      if (s.mode === "hls" && s.src.fallback_url) {
        seekTo.current = video.current?.currentTime || seekTo.current;
        return { ...s, mode: "mp4" };
      }
      return { kind: "error", code: null };
    });
  }, [setStatus]);

  // ---- attach the stream.
  const ready = status.kind === "ready" ? status : null;
  const url = ready ? (ready.mode === "mp4" ? (ready.src.fallback_url ?? ready.src.stream_url) : ready.src.stream_url) : null;
  const mode = ready?.mode;
  useEffect(() => {
    const el = video.current;
    if (!el || !url) return;
    let h: HlsHandle | null = null;
    let gone = false;
    const onError = () => toFallback();
    el.addEventListener("error", onError);
    (async () => {
      const how = mode === "mp4" ? "file" : await hlsPlayable(el);
      if (gone) return;
      if (how === "hlsjs") {
        const x = await attachHls(el, url, () => toFallback());
        if (gone) x.destroy();
        else h = x;
      } else if (how === "native" || how === "file") {
        el.src = url;
      } else {
        toFallback();
      }
    })().catch(() => !gone && toFallback());
    return () => {
      gone = true;
      el.removeEventListener("error", onError);
      h?.destroy();
      el.removeAttribute("src");
      el.load();
    };
  }, [url, mode, toFallback]);

  // ---- start position: the pending seek (quality switch) or the resume point.
  const src = ready?.src;
  const onLoaded = () => {
    const el = video.current;
    if (!el || !src) return;
    const dur = Number.isFinite(el.duration) ? el.duration : (src.duration_seconds ?? null);
    const pending = seekTo.current;
    seekTo.current = null;
    const at = pending ?? resumePosition(src.position_seconds ?? startAt, dur);
    if (at > 0) {
      el.currentTime = at;
      if (pending == null) setResumedAt(at);
    }
    lastSent.current = at || null;
    void el.play().catch(() => {});
  };

  // ---- progress reports (every 10 s of playback, pause, end, leaving).
  const report = useCallback(
    (force: boolean) => {
      const el = video.current;
      if (!el || !profileId || !src) return;
      const pos = el.ended ? el.duration : el.currentTime;
      if (!force && !shouldReport(lastSent.current, pos)) return;
      if (!Number.isFinite(pos) || pos < 1 || pos === lastSent.current) return;
      lastSent.current = pos;
      const dur = Number.isFinite(el.duration) ? el.duration : (src.duration_seconds ?? null);
      reportVideoProgress(profileId, videoId, pos, dur).catch(() => {});
    },
    [profileId, src, videoId],
  );
  useEffect(() => {
    const flush = () => report(true);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
      void qc.invalidateQueries({ queryKey: ["video", "continue"] });
      void qc.invalidateQueries({ queryKey: ["video", "history"] });
    };
  }, [report, qc]);

  useEffect(() => {
    onReady?.({ position: () => video.current?.currentTime ?? 0 });
  }, [onReady]);

  const pickQuality = (q: number) => {
    seekTo.current = video.current?.currentTime || null;
    report(true);
    setQuality(q);
  };
  const audioOpts = src && mode !== "mp4" ? audioOptions(src.audio_tracks, src.audio_track) : [];
  const pickAudio = (id: string) => {
    const o = audioOpts.find((x) => x.id === id);
    if (!o) return;
    const pref = prefForTrack(o);
    videoAudioPref.set(pref);
    if (o.selected) return;
    seekTo.current = video.current?.currentTime || null;
    report(true);
    setAudio(pref);
  };
  const fromStart = () => {
    const el = video.current;
    if (el) el.currentTime = 0;
    setResumedAt(0);
  };

  const current = src?.quality ?? quality ?? null;
  const shown = qualities.length ? qualities : (src?.qualities ?? []);
  const errorText =
    status.kind === "error"
      ? status.code === "video_live_unsupported"
        ? t("video.live_unsupported")
        : status.code === "video_unavailable"
          ? t("video.unavailable")
          : status.code === "video_unplayable"
            ? t("video.unplayable")
            : t("video.web.playback_failed")
      : null;

  return (
    <div data-testid="video-player">
      <div className="relative -mx-4 aspect-video overflow-hidden bg-black sm:mx-0 sm:rounded-2xl">
        <video
          ref={video}
          className="absolute inset-0 h-full w-full"
          poster={poster}
          controls
          playsInline
          preload="metadata"
          data-testid="video-element"
          data-mode={mode ?? ""}
          onLoadedMetadata={onLoaded}
          onTimeUpdate={() => report(false)}
          onPause={() => report(true)}
          onEnded={() => {
            report(true);
            onEnded?.();
          }}
        >
          {src?.subtitles?.map((s, i) => <track key={s.url} kind="subtitles" src={s.url} srcLang={s.lang ?? undefined} label={s.label ?? `CC ${i + 1}`} />)}
        </video>
        {status.kind === "loading" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Spinner />
          </div>
        )}
        {errorText && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 px-6 text-center text-white" role="alert" data-testid="video-player-error">
            <AlertIcon className="text-3xl text-warn" />
            <p className="max-w-sm text-sm">{errorText}</p>
            <a
              href={`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`}
              target="_blank"
              rel="noreferrer"
              className="mt-1 rounded-lg bg-white/15 px-3 py-1.5 text-sm hover:bg-white/25"
              data-testid="video-open-youtube"
            >
              {t("video.open_youtube")}
            </a>
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        {shown.length > 1 && mode !== "mp4" && (
          <label className="inline-flex items-center gap-2 text-muted">
            {t("video.quality")}
            <select
              value={current ?? ""}
              onChange={(e) => pickQuality(Number(e.target.value))}
              className="min-h-[36px] rounded-lg border border-border bg-surface px-2 text-text"
              data-testid="video-quality"
            >
              {shown.map((q) => (
                <option key={q} value={q}>
                  {qualityLabel(q)}
                </option>
              ))}
            </select>
          </label>
        )}
        {audioOpts.length > 1 && (
          <label className="inline-flex items-center gap-2 text-muted" title={t("ytaudio.hint")}>
            {t("ytaudio.title")}
            <select
              value={audioOpts.find((o) => o.selected)?.id ?? ""}
              onChange={(e) => pickAudio(e.target.value)}
              className="min-h-[36px] max-w-[60vw] rounded-lg border border-border bg-surface px-2 text-text"
              data-testid="video-audio"
            >
              {audioOpts.map((o) => (
                <option key={o.id} value={o.id}>
                  {audioLabel(o, t, locale)}
                </option>
              ))}
            </select>
          </label>
        )}
        {mode === "mp4" && ready?.src.format === "hls" && (
          <span className="rounded-full bg-warn/15 px-2.5 py-1 text-xs font-medium text-warn" data-testid="video-fallback">
            {t("video.web.fallback_mode")}
          </span>
        )}
        {resumedAt > 0 && (
          <span className="inline-flex items-center gap-2 rounded-full bg-surface-2 py-1 pl-3 pr-1 text-xs" data-testid="video-resumed">
            {t("video.resume", { time: formatDuration(resumedAt) })}
            <button type="button" onClick={fromStart} className="rounded-full bg-surface px-2.5 py-1 font-semibold hover:bg-border" data-testid="video-from-start">
              {t("video.web.from_start")}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { clock, useT } from "../core/i18n";
import { getSettings } from "../core/store";
import { usePlayback } from "../shared/playback";
import type { MediaType } from "../core/tmdb";
import { IconBack, IconFullscreen, IconLayers, IconMic, IconNext, IconPause, IconPlay, IconPrev, IconVolume } from "../shared/icons";
import { goBack, navigate, playHref, titleHref } from "./router";
import { Menu, Spinner } from "./ui";
import { Mascot } from "../shared/marty";

export function PlayerPage({ type, id, season, episode, fromStart }: { type: MediaType; id: number; season?: number; episode?: number; fromStart?: boolean }) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const nextRef = useRef<() => void>(() => undefined);
  const pb = usePlayback({ type, id, season, episode, fromStart }, video, () => nextRef.current());
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [waiting, setWaiting] = useState(true);
  const [ui, setUi] = useState(true);
  const [vol, setVol] = useState(() => Number(localStorage.getItem("cineko.volume") ?? 1));
  const [muted, setMuted] = useState(false);
  const [toast, setToast] = useState("");
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const back = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    goBack(titleHref(type, id));
  }, [type, id]);

  nextRef.current = () => {
    if (pb.next && getSettings().autoNext) navigate(playHref("tv", id, pb.next.season, pb.next.episode), true);
  };

  const poke = useCallback(() => {
    setUi(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (video.current && !video.current.paused && !document.querySelector(".menu.open")) setUi(false);
    }, 3200);
  }, []);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((m) => (m === msg ? "" : m)), 1200);
  };

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.volume = Math.min(1, Math.max(0, vol));
    const on = () => {
      setPaused(v.paused);
      setTime(v.currentTime);
      setDur(isFinite(v.duration) ? v.duration : 0);
      try {
        const b = v.buffered;
        for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 1 && b.end(i) >= v.currentTime) setBuffered(b.end(i));
      } catch {
        /* ignore */
      }
    };
    const w = () => setWaiting(true);
    const p = () => setWaiting(false);
    const evs = ["timeupdate", "play", "pause", "durationchange", "progress", "seeked", "loadedmetadata"];
    evs.forEach((e) => v.addEventListener(e, on));
    v.addEventListener("waiting", w);
    v.addEventListener("loadstart", w);
    v.addEventListener("playing", p);
    v.addEventListener("canplay", p);
    v.addEventListener("pause", poke);
    return () => {
      evs.forEach((e) => v.removeEventListener(e, on));
      v.removeEventListener("waiting", w);
      v.removeEventListener("loadstart", w);
      v.removeEventListener("playing", p);
      v.removeEventListener("canplay", p);
      v.removeEventListener("pause", poke);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    poke();
    return () => clearTimeout(hideTimer.current);
  }, [poke]);

  useEffect(() => {
    document.title = pb.title ? `${pb.title}${type === "tv" ? ` · ${pb.subtitle}` : ""} — Cineko` : "Cineko Lite";
  }, [pb.title, pb.subtitle, type]);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => undefined);
    else v.pause();
  };
  const seek = (to: number) => {
    const v = video.current;
    if (!v || !isFinite(v.duration)) return;
    v.currentTime = Math.max(0, Math.min(v.duration - 1, to));
  };
  const setVolume = (x: number) => {
    const v = video.current;
    const n = Math.min(1, Math.max(0, x));
    setVol(n);
    localStorage.setItem("cineko.volume", String(n));
    if (v) {
      v.volume = n;
      v.muted = false;
      setMuted(false);
    }
  };
  const fullscreen = () => {
    const el = shell.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;
    const vEl = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (el?.requestFullscreen) void el.requestFullscreen().catch(() => vEl?.webkitEnterFullscreen?.());
    else vEl?.webkitEnterFullscreen?.();
  };
  const goEp = (e: { season: number; episode: number } | null) => e && navigate(playHref("tv", id, e.season, e.episode), true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const v = video.current;
      if (!v) return;
      poke();
      switch (e.key) {
        case " ":
        case "k":
        case "K":
        case "MediaPlayPause":
          e.preventDefault();
          toggle();
          break;
        case "ArrowLeft":
        case "j":
          e.preventDefault();
          seek(v.currentTime - (e.shiftKey ? 30 : 10));
          flash(`−${e.shiftKey ? 30 : 10} ${t("sec")}`);
          break;
        case "ArrowRight":
        case "l":
          e.preventDefault();
          seek(v.currentTime + (e.shiftKey ? 30 : 10));
          flash(`+${e.shiftKey ? 30 : 10} ${t("sec")}`);
          break;
        case "ArrowUp":
          e.preventDefault();
          setVolume(v.volume + 0.1);
          flash(`🔊 ${Math.round(Math.min(1, v.volume) * 100)}%`);
          break;
        case "ArrowDown":
          e.preventDefault();
          setVolume(v.volume - 0.1);
          flash(`🔉 ${Math.round(Math.max(0, v.volume) * 100)}%`);
          break;
        case "f":
        case "F":
        case "а":
        case "А":
          fullscreen();
          break;
        case "m":
        case "M":
          v.muted = !v.muted;
          setMuted(v.muted);
          break;
        case "n":
        case "N":
        case "MediaTrackNext":
          goEp(pb.next);
          break;
        case "p":
        case "P":
        case "MediaTrackPrevious":
          goEp(pb.prev);
          break;
        case "Escape":
        case "Backspace":
          if (!document.fullscreenElement) back();
          break;
        default:
          if (/^[0-9]$/.test(e.key) && isFinite(v.duration)) seek((v.duration * Number(e.key)) / 10);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const epName = pb.episodeName;
  const pct = dur ? (time / dur) * 100 : 0;
  const bufPct = dur ? (buffered / dur) * 100 : 0;

  return (
    <div
      ref={shell}
      className={`player ${ui || paused ? "ui" : ""}`}
      onMouseMove={poke}
      onTouchStart={poke}
      onClick={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("player-tap")) {
          if (window.matchMedia("(hover: none)").matches && !ui) poke();
          else toggle();
        }
      }}
    >
      <video ref={video} className="player-video" playsInline preload="auto" onDoubleClick={fullscreen} />
      <div className="player-tap" />

      {pb.phase === "loading" || (pb.phase === "ready" && waiting && !paused) ? (
        <div className="player-center">
          <Spinner small={pb.phase !== "loading"} />
        </div>
      ) : null}
      {pb.phase === "ready" && paused && !waiting ? (
        <button className="player-big" onClick={toggle} aria-label={t("play")}>
          <IconPlay size={44} />
        </button>
      ) : null}
      {pb.phase === "nosource" || pb.phase === "error" ? (
        <div className="player-center msg">
          <Mascot mood={pb.phase === "nosource" ? "sleepy" : "error"} size={140} />
          <p>{pb.phase === "nosource" ? (pb.voices.length ? t("noVoices") : t("noSource")) : t("sourceError")}</p>
          {pb.error ? <p className="muted small">{pb.error}</p> : null}
          <div className="row-btns">
            {pb.phase === "error" ? (
              <button className="btn primary" onClick={pb.retry}>
                {t("retry")}
              </button>
            ) : null}
            <button className="btn" onClick={back}>
              {t("back")}
            </button>
          </div>
        </div>
      ) : null}
      {toast ? <div className="player-toast">{toast}</div> : null}

      <div className="player-top">
        <button className="icon-btn" onClick={back} aria-label={t("back")}>
          <IconBack />
        </button>
        <div className="player-titles">
          <div className="player-title">{pb.title}</div>
          <div className="player-sub">
            {type === "tv" && season != null ? `${t("season")} ${season} · ${t("episode")} ${episode}${epName ? ` — ${epName}` : ""}` : pb.subtitle}
            {pb.voice ? ` · ${pb.voice.label}` : ""}
          </div>
        </div>
      </div>

      <div className="player-bottom" onClick={(e) => e.stopPropagation()}>
        <div
          className="seek"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            seek(((e.clientX - r.left) / r.width) * dur);
          }}
        >
          <div className="seek-buf" style={{ width: `${bufPct}%` }} />
          <div className="seek-fill" style={{ width: `${pct}%` }} />
          <div className="seek-knob" style={{ left: `${pct}%` }} />
          <input
            type="range"
            min={0}
            max={dur || 0}
            step={1}
            value={Math.floor(time)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="seek"
          />
        </div>
        <div className="controls">
          <div className="controls-left">
            {type === "tv" ? (
              <button className="icon-btn" disabled={!pb.prev} onClick={() => goEp(pb.prev)} title={t("prev")}>
                <IconPrev />
              </button>
            ) : null}
            <button className="icon-btn play" onClick={toggle} aria-label={paused ? t("play") : t("pause")}>
              {paused ? <IconPlay /> : <IconPause />}
            </button>
            {type === "tv" ? (
              <button className="icon-btn" disabled={!pb.next} onClick={() => goEp(pb.next)} title={t("nextEpisode")}>
                <IconNext />
              </button>
            ) : null}
            <div className="volume">
              <button
                className="icon-btn"
                onClick={() => {
                  const v = video.current;
                  if (v) {
                    v.muted = !v.muted;
                    setMuted(v.muted);
                  }
                }}
                aria-label={t("mute")}
              >
                <IconVolume muted={muted || vol === 0} />
              </button>
              <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : vol} onChange={(e) => setVolume(Number(e.target.value))} aria-label={t("mute")} />
            </div>
            <span className="time">
              {clock(time)} <span className="muted">/ {clock(dur)}</span>
            </span>
          </div>
          <div className="controls-right">
            {pb.voices.length > 0 ? (
              <Menu up label={t("voice")} icon={<IconMic size={18} />} value={pb.voice?.key} options={pb.voices.map((v) => ({ value: v.key, label: v.label }))} onPick={pb.setVoice} />
            ) : null}
            {pb.qualities.length > 0 ? (
              <Menu
                up
                label={t("quality")}
                icon={<IconLayers size={18} />}
                value={pb.format === "hls" ? 0 : pb.quality}
                options={[...pb.qualities.map((q) => ({ value: q, label: `${q}p`, hint: q >= 2160 ? "4K" : q >= 1440 ? "2K" : q >= 1080 ? "Full HD" : q >= 720 ? "HD" : undefined }))]}
                onPick={pb.setQuality}
              />
            ) : null}
            {type === "tv" && pb.seasons.length ? (
              <Menu
                up
                label={t("episodes")}
                value={`${season}:${episode}`}
                options={pb.seasons.flatMap((s) =>
                  s.episodes.map((e) => ({
                    value: `${s.season}:${e.episode}`,
                    label: `${t("s")}${s.season} · ${t("ep")}${e.episode}`,
                    hint: s.season === season ? pb.seasonEpisodes.find((x) => x.episode_number === e.episode)?.name : undefined,
                  })),
                )}
                onPick={(v) => {
                  const [a, b] = String(v).split(":").map(Number);
                  goEp({ season: a, episode: b });
                }}
              />
            ) : null}
            <button className="icon-btn" onClick={fullscreen} aria-label={t("fullscreen")}>
              <IconFullscreen />
            </button>
          </div>
        </div>
        <div className="kbd-hint">{t("keyboardHint")}</div>
      </div>
    </div>
  );
}

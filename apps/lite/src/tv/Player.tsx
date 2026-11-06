import { useEffect, useRef, useState } from "react";
import { clock, useT } from "../core/i18n";
import { getSettings } from "../core/store";
import type { MediaType } from "../core/tmdb";
import { usePlayback } from "../shared/playback";
import { IconLayers, IconMic, IconNext, IconPause, IconPlay, IconPrev } from "../shared/icons";
import { focusInitial, pushKeys } from "./nav";
import { F, useNav } from "./ui";
import { Mascot } from "../shared/marty";

type PanelTab = "episodes" | "voice" | "quality";

export function TvPlayer({ type, id, season, episode, fromStart }: { type: MediaType; id: number; season?: number; episode?: number; fromStart?: boolean }) {
  const t = useT();
  const nav = useNav();
  const video = useRef<HTMLVideoElement>(null);
  const nextRef = useRef<() => void>(() => undefined);
  const pb = usePlayback({ type, id, season, episode, fromStart }, video, () => nextRef.current());
  const [paused, setPaused] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [waiting, setWaiting] = useState(true);
  const [osd, setOsd] = useState(true);
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const [seekTo, setSeekTo] = useState<number | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const seekTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const seekRun = useRef({ at: 0, n: 0, dir: 0 });
  const panelRef = useRef<HTMLDivElement>(null);

  const goEp = (e: { season: number; episode: number } | null) => {
    if (e) nav.replace({ name: "play", type: "tv", id, season: e.season, episode: e.episode });
  };
  nextRef.current = () => {
    if (pb.next && getSettings().autoNext) goEp(pb.next);
    else nav.back();
  };

  const showOsd = () => {
    setOsd(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (video.current && !video.current.paused) setOsd(false);
    }, 4000);
  };

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const on = () => {
      setPaused(v.paused);
      setTime(v.currentTime);
      setDur(isFinite(v.duration) ? v.duration : 0);
    };
    const w = () => setWaiting(true);
    const p = () => setWaiting(false);
    const evs = ["timeupdate", "play", "pause", "durationchange", "seeked", "loadedmetadata"];
    evs.forEach((e) => v.addEventListener(e, on));
    v.addEventListener("waiting", w);
    v.addEventListener("loadstart", w);
    v.addEventListener("playing", p);
    v.addEventListener("canplay", p);
    showOsd();
    return () => {
      evs.forEach((e) => v.removeEventListener(e, on));
      v.removeEventListener("waiting", w);
      v.removeEventListener("loadstart", w);
      v.removeEventListener("playing", p);
      v.removeEventListener("canplay", p);
      clearTimeout(hideTimer.current);
      clearTimeout(seekTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus inside the panel when it opens.
  const isOpen = panel != null;
  useEffect(() => {
    if (isOpen) requestAnimationFrame(() => focusInitial(undefined, panelRef.current));
  }, [isOpen]);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => undefined);
    else v.pause();
    showOsd();
  };

  /** ◀ ▶: steps grow while the key is held / pressed repeatedly; the seek lands when you stop. */
  const nudge = (dir: 1 | -1, base = 10) => {
    const v = video.current;
    if (!v || !isFinite(v.duration)) return;
    const now = Date.now();
    const r = seekRun.current;
    if (now - r.at < 700 && r.dir === dir) r.n++;
    else r.n = 0;
    r.at = now;
    r.dir = dir;
    const step = base * (r.n < 3 ? 1 : r.n < 8 ? 3 : r.n < 16 ? 6 : 12);
    setSeekTo((cur) => {
      const from = cur ?? v.currentTime;
      return Math.max(0, Math.min(v.duration - 2, from + dir * step));
    });
    showOsd();
    clearTimeout(seekTimer.current);
    seekTimer.current = setTimeout(() => {
      setSeekTo((target) => {
        if (target != null && video.current) video.current.currentTime = target;
        return null;
      });
    }, 650);
  };

  useEffect(
    () =>
      pushKeys((k) => {
        if (panel) {
          if (k === "back") {
            setPanel(null);
            return true;
          }
          if (k === "playpause") {
            toggle();
            return true;
          }
          return false; // arrows / OK: navigation inside the panel
        }
        switch (k) {
          case "ok":
          case "playpause":
            toggle();
            return true;
          case "play":
            video.current?.play().catch(() => undefined);
            showOsd();
            return true;
          case "pause":
            video.current?.pause();
            showOsd();
            return true;
          case "left":
            nudge(-1);
            return true;
          case "right":
            nudge(1);
            return true;
          case "rew":
            nudge(-1, 30);
            return true;
          case "ff":
            nudge(1, 30);
            return true;
          case "up":
          case "down":
            if (pb.phase === "ready" || pb.voices.length) {
              setPanel(type === "tv" && pb.seasons.length ? "episodes" : "voice");
              showOsd();
            }
            return true;
          case "next":
            goEp(pb.next);
            return true;
          case "prev":
            goEp(pb.prev);
            return true;
          case "stop":
            nav.back();
            return true;
          default:
            return false; // back → the app pops the player
        }
      }),
  );

  const shown = seekTo ?? time;
  const pct = dur ? (shown / dur) * 100 : 0;
  const tabs: PanelTab[] = [...(type === "tv" && pb.seasons.length ? (["episodes"] as PanelTab[]) : []), "voice", "quality"];
  const epName = pb.episodeName;

  return (
    <div className={`tplayer ${osd || paused || panel ? "osd" : ""}`}>
      <video ref={video} className="tplayer-video" preload="auto" />
      {pb.phase === "loading" || (pb.phase === "ready" && waiting && seekTo == null) ? (
        <div className="tplayer-center">
          {pb.phase === "loading" ? <Mascot mood="loading" animated size={200} /> : <div className="spinner big" />}
        </div>
      ) : null}
      {pb.phase === "nosource" || pb.phase === "error" ? (
        <div className="tplayer-center msg" data-scope="">
          <Mascot mood={pb.phase === "nosource" ? "sleepy" : "error"} size={200} />
          <div className="tplayer-msg">{pb.phase === "nosource" ? (pb.voices.length ? t("noVoices") : t("noSource")) : t("sourceError")}</div>
          {pb.error ? <div className="muted">{pb.error}</div> : null}
          <div className="tbtns">
            {pb.phase === "error" ? (
              <F fk="pl-retry" className="tbtn primary" autoFocus onPress={pb.retry}>
                {t("retry")}
              </F>
            ) : null}
            <F fk="pl-back" className="tbtn" autoFocus={pb.phase !== "error"} onPress={nav.back}>
              {t("back")}
            </F>
          </div>
          <FocusOnMount />
        </div>
      ) : null}
      {pb.phase === "ready" && paused && !waiting && !panel ? (
        <div className="tplayer-center">
          <div className="tplayer-big">
            <IconPlay size={80} />
          </div>
        </div>
      ) : null}

      <div className="tplayer-top">
        <div className="tplayer-title">{pb.title}</div>
        <div className="tplayer-sub">
          {type === "tv" && season != null ? `${t("season")} ${season} · ${t("episode")} ${episode}${epName ? ` — ${epName}` : ""}` : pb.subtitle}
          {pb.voice ? <span className="tplayer-voice">{pb.voice.label}</span> : null}
          {pb.format ? <span className="tplayer-voice">{pb.format === "hls" ? "HLS" : `${pb.quality}p`}</span> : null}
        </div>
      </div>

      <div className="tplayer-bottom">
        <div className="tplayer-bar">
          <div className="tplayer-fill" style={{ width: `${pct}%` }} />
          <div className="tplayer-knob" style={{ left: `${pct}%` }} />
        </div>
        <div className="tplayer-times">
          <span className="tplayer-state">{paused ? <IconPause size={30} /> : <IconPlay size={30} />}</span>
          <span className={seekTo != null ? "accent" : ""}>{clock(shown)}</span>
          <span className="muted">/ {clock(dur)}</span>
          <span className="tplayer-hint">{t("panelHint")}</span>
          {type === "tv" ? (
            <span className="tplayer-eps">
              <span className={pb.prev ? "" : "off"}>
                <IconPrev size={26} />
              </span>
              <span className={pb.next ? "" : "off"}>
                <IconNext size={26} />
              </span>
            </span>
          ) : null}
        </div>
      </div>

      {panel ? (
        <div className="tpanel" data-scope="" ref={panelRef}>
          <div className="tpanel-tabs" data-group="tabs">
            {tabs.map((tab) => (
              <F key={tab} fk={`tab:${tab}`} className={`tpanel-tab ${panel === tab ? "on" : ""}`} onFocus={() => setPanel(tab)} onPress={() => setPanel(tab)}>
                {tab === "episodes" ? t("episodes") : tab === "voice" ? (
                  <>
                    <IconMic size={26} /> {t("voice")}
                  </>
                ) : (
                  <>
                    <IconLayers size={26} /> {t("quality")}
                  </>
                )}
              </F>
            ))}
          </div>
          <div className="tpanel-list" data-scroll="x" data-pad="100" data-group={`list-${panel}`}>
            <div className="trow-track">
              {panel === "voice"
                ? pb.voices.map((v) => (
                    <F
                      key={v.key}
                      fk={`pv:${v.key}`}
                      className={`tchip ${pb.voice?.key === v.key ? "on" : ""}`}
                      autoFocus={pb.voice?.key === v.key}
                      isDefault={pb.voice?.key === v.key}
                      onPress={() => {
                        pb.setVoice(v.key);
                        setPanel(null);
                      }}
                    >
                      {v.label}
                    </F>
                  ))
                : null}
              {panel === "quality"
                ? pb.qualities.map((q) => (
                    <F
                      key={q}
                      fk={`pq:${q}`}
                      className={`tchip ${pb.format === "mp4" && pb.quality === q ? "on" : ""}`}
                      autoFocus={pb.quality === q}
                      isDefault={pb.quality === q}
                      onPress={() => {
                        pb.setQuality(q);
                        setPanel(null);
                      }}
                    >
                      {q}p
                    </F>
                  ))
                : null}
              {panel === "episodes"
                ? pb.seasons.flatMap((s) =>
                    s.episodes.map((e) => {
                      const cur = s.season === season && e.episode === episode;
                      const name = s.season === season ? pb.seasonEpisodes.find((x) => x.episode_number === e.episode)?.name : "";
                      return (
                        <F
                          key={`${s.season}-${e.episode}`}
                          fk={`pe:${s.season}:${e.episode}`}
                          className={`tchip ep ${cur ? "on" : ""}`}
                          autoFocus={cur}
                          isDefault={cur}
                          onPress={() => {
                            setPanel(null);
                            if (!cur) goEp({ season: s.season, episode: e.episode });
                          }}
                        >
                          <span className="tchip-top">
                            {t("s")}
                            {s.season} · {t("ep")}
                            {e.episode}
                          </span>
                          {name ? <span className="tchip-name">{name}</span> : null}
                        </F>
                      );
                    }),
                  )
                : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FocusOnMount() {
  useEffect(() => {
    requestAnimationFrame(() => focusInitial(undefined, document.querySelector<HTMLElement>(".tplayer-center.msg")));
  }, []);
  return null;
}

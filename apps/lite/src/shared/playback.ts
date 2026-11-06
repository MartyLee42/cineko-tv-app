// The player's brain, shared by the web and TV players: resolves the title →
// IMDb id → CDNVideoHub playlist → voice → signed stream, feeds the <video>
// (progressive MP4; HLS as fallback via native support or hls.js), restores
// the resume position and records progress.
import { useCallback, useEffect, useRef, useState } from "react";
import { chooseQuality, fetchPlaylist, fetchVideo, pickVoice, type SeasonEntry, type VideoInfo, type Voice } from "../core/cvh";
import { details, imdbOf, season as loadSeason, titleOf, yearOf, type Details, type Episode, type MediaType } from "../core/tmdb";
import { getPosition, getSettings, isWatched, preferredQuality, preferredVoice, saveProgress, setPreferredQuality, setPreferredVoice, setSettings } from "../core/store";
import { neighbour, sourceFrom, type EpisodeRef } from "./source";

export interface PlayTarget {
  type: MediaType;
  id: number;
  season?: number;
  episode?: number;
  /** Start from 0 instead of the saved position. */
  fromStart?: boolean;
}

type HlsLike = { destroy(): void; loadSource(u: string): void; attachMedia(v: HTMLVideoElement): void; on(ev: string, cb: (e: unknown, d: { fatal?: boolean; type?: string }) => void): void };

export interface Playback {
  phase: "loading" | "nosource" | "error" | "ready";
  error: string;
  details?: Details;
  title: string;
  subtitle: string;
  episodeName: string;
  voices: Voice[];
  voice?: Voice;
  qualities: number[];
  quality: number;
  format: "mp4" | "hls" | "";
  seasons: SeasonEntry[];
  seasonEpisodes: Episode[];
  next: EpisodeRef | null;
  prev: EpisodeRef | null;
  setVoice: (key: string) => void;
  setQuality: (q: number) => void;
  retry: () => void;
}

function canNativeHls(v: HTMLVideoElement): boolean {
  try {
    return !!v.canPlayType("application/vnd.apple.mpegurl");
  } catch {
    return false;
  }
}

export function usePlayback(target: PlayTarget, videoRef: React.RefObject<HTMLVideoElement | null>, onEnded: () => void): Playback {
  const [d, setD] = useState<Details>();
  const [phase, setPhase] = useState<Playback["phase"]>("loading");
  const [error, setError] = useState("");
  const [voices, setVoices] = useState<Voice[]>([]);
  const [seasons, setSeasons] = useState<SeasonEntry[]>([]);
  const [voiceKey, setVoiceKey] = useState<string>();
  const [info, setInfo] = useState<VideoInfo>();
  const [quality, setQualityState] = useState(0);
  const [format, setFormat] = useState<Playback["format"]>("");
  const [seasonEpisodes, setSeasonEpisodes] = useState<Episode[]>([]);
  const [nonce, setNonce] = useState(0);
  const hlsRef = useRef<HlsLike | null>(null);
  const triedRef = useRef<{ fresh: boolean; hls: boolean }>({ fresh: false, hls: false });
  const startAtRef = useRef<number>(-1);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  const { type, id } = target;
  const sn = target.season;
  const ep = target.episode;
  const epKey = `${type}:${id}:${sn ?? ""}:${ep ?? ""}`;

  // 1. Title details + playlist.
  useEffect(() => {
    let alive = true;
    setPhase("loading");
    setError("");
    setInfo(undefined);
    (async () => {
      const det = await details(type, id);
      if (!alive) return;
      setD(det);
      const imdb = imdbOf(det);
      if (!imdb) {
        setPhase("nosource");
        return;
      }
      const pl = await fetchPlaylist(imdb);
      if (!alive) return;
      const src = sourceFrom(type, pl);
      setSeasons(src.seasons);
      let vs: Voice[] = src.voices;
      if (type === "tv") {
        const s = src.seasons.find((x) => x.season === sn);
        vs = s?.episodes.find((e) => e.episode === ep)?.voices ?? [];
      }
      setVoices(vs);
      if (!vs.length) {
        setPhase("nosource");
        return;
      }
      const v = pickVoice(vs, preferredVoice({ type, id }));
      setVoiceKey(v?.key);
      const pos = getPosition(type, id, sn, ep);
      startAtRef.current = target.fromStart || !pos || isWatched(pos) || pos.pos < 15 ? 0 : Math.max(0, pos.pos - 3);
    })().catch((e) => {
      if (!alive) return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epKey, nonce]);

  // Episode names of the current season (for the panel and the title line).
  useEffect(() => {
    if (type !== "tv" || sn == null) return;
    let alive = true;
    loadSeason(id, sn).then(
      (s) => alive && setSeasonEpisodes(s.episodes ?? []),
      () => alive && setSeasonEpisodes([]),
    );
    return () => {
      alive = false;
    };
  }, [type, id, sn]);

  const voice = voices.find((v) => v.key === voiceKey);

  // 2. Signed stream URLs of the chosen voice.
  useEffect(() => {
    if (!voice) return;
    let alive = true;
    triedRef.current = { fresh: false, hls: false };
    fetchVideo(voice.vkId).then(
      (vi) => {
        if (!alive) return;
        setInfo(vi);
        setQualityState(chooseQuality(vi.ladder.map((r) => r.q), preferredQuality({ type, id }) ?? getSettings().quality));
      },
      (e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice?.vkId, nonce]);

  const destroyHls = () => {
    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch {
        /* ignore */
      }
      hlsRef.current = null;
    }
  };

  // 3. Feed the <video>.
  const attach = useCallback(
    async (vi: VideoInfo, q: number, forceHls: boolean) => {
      const v = videoRef.current;
      if (!v) return;
      const at = startAtRef.current >= 0 ? startAtRef.current : v.currentTime || 0;
      startAtRef.current = -1;
      const wasPaused = v.paused && v.currentTime > 0;
      destroyHls();
      const r = vi.ladder.find((x) => x.q === q);
      const seekAndPlay = () => {
        if (at > 0) {
          try {
            v.currentTime = at;
          } catch {
            /* ignore */
          }
        }
        if (!wasPaused) v.play().catch(() => undefined);
      };
      v.addEventListener("loadedmetadata", seekAndPlay, { once: true });
      if (r && !forceHls) {
        setFormat("mp4");
        v.src = r.url;
      } else if (vi.hls) {
        setFormat("hls");
        if (canNativeHls(v)) v.src = vi.hls;
        else {
          const mod = await import("hls.js");
          const Hls = mod.default;
          if (!Hls.isSupported()) {
            setError("HLS unsupported");
            setPhase("error");
            return;
          }
          const hls = new Hls({ maxBufferLength: 30 }) as unknown as HlsLike;
          hlsRef.current = hls;
          hls.on("hlsError", (_e, data) => {
            if (data?.fatal) {
              setError("HLS: " + (data.type ?? "error"));
              setPhase("error");
            }
          });
          hls.loadSource(vi.hls);
          hls.attachMedia(v);
        }
      } else {
        setError("no stream");
        setPhase("error");
        return;
      }
      setPhase("ready");
    },
    [videoRef],
  );

  useEffect(() => {
    if (!info) return;
    void attach(info, quality, triedRef.current.hls);
  }, [info, quality, attach]);

  // Errors: re-sign once (expired URLs), then fall back to HLS.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onErr = () => {
      if (!voice || !info || !v.error) return;
      const at = v.currentTime;
      if (!triedRef.current.fresh) {
        triedRef.current.fresh = true;
        startAtRef.current = at;
        fetchVideo(voice.vkId, true).then(setInfo, () => undefined);
        return;
      }
      if (!triedRef.current.hls && info.hls && format === "mp4") {
        triedRef.current.hls = true;
        startAtRef.current = at;
        void attach(info, 0, true);
        return;
      }
      setError(`media error ${v.error.code}`);
      setPhase("error");
    };
    v.addEventListener("error", onErr);
    return () => v.removeEventListener("error", onErr);
  }, [videoRef, voice, info, format, attach]);

  // Progress: every 5 s, on pause and when leaving.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !d) return;
    const save = () => {
      if (!v.duration || !isFinite(v.duration) || v.currentTime < 5) return;
      saveProgress({
        type,
        id,
        title: titleOf(d),
        poster: d.poster_path,
        backdrop: d.backdrop_path,
        year: yearOf(d),
        rating: d.vote_average,
        season: sn,
        episode: ep,
        voice: voice?.key,
        position: v.currentTime,
        duration: v.duration,
      });
    };
    const timer = setInterval(() => !v.paused && save(), 5000);
    const ended = () => {
      save();
      onEndedRef.current();
    };
    v.addEventListener("pause", save);
    v.addEventListener("ended", ended);
    window.addEventListener("pagehide", save);
    return () => {
      save();
      clearInterval(timer);
      v.removeEventListener("pause", save);
      v.removeEventListener("ended", ended);
      window.removeEventListener("pagehide", save);
    };
  }, [videoRef, d, type, id, sn, ep, voice?.key]);

  useEffect(() => () => destroyHls(), []);

  const cur = sn != null && ep != null ? { season: sn, episode: ep } : null;
  const epName = type === "tv" && ep != null ? (seasonEpisodes.find((e) => e.episode_number === ep)?.name ?? "") : "";

  return {
    phase,
    error,
    details: d,
    title: d ? titleOf(d) : "",
    subtitle: type === "tv" && sn != null ? `S${sn} · E${ep}` : d ? yearOf(d) : "",
    episodeName: epName,
    voices,
    voice,
    qualities: info ? info.ladder.map((r) => r.q) : [],
    quality,
    format,
    seasons,
    seasonEpisodes,
    next: type === "tv" && cur ? neighbour(seasons, cur, 1) : null,
    prev: type === "tv" && cur ? neighbour(seasons, cur, -1) : null,
    setVoice: (key) => {
      if (key === voiceKey) return;
      const v = videoRef.current;
      startAtRef.current = v ? v.currentTime : 0;
      setPreferredVoice({ type, id }, key);
      setVoiceKey(key);
    },
    setQuality: (q) => {
      if (q === quality) return;
      const v = videoRef.current;
      startAtRef.current = v ? v.currentTime : 0;
      triedRef.current.hls = false;
      setPreferredQuality({ type, id }, q);
      setSettings({ quality: q });
      setQualityState(q);
    },
    retry: () => {
      const v = videoRef.current;
      startAtRef.current = v && v.currentTime > 0 ? v.currentTime : -1;
      if (startAtRef.current < 0) startAtRef.current = getPosition(type, id, sn, ep)?.pos ?? 0;
      setNonce((n) => n + 1);
    },
  };
}

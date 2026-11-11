import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, dzId, img, sized, type Track } from "./api";
import { isDownloaded, offlineUrl } from "./offline";
import { Starter, continueBody, resolvePath, silenceWav, withRev } from "./playback";
import { toast } from "./toast";

export type Repeat = "off" | "all" | "one";

export interface PlayContext {
  type: "album" | "artist" | "playlist" | "myplaylist" | "liked" | "flow" | "radio" | "search" | "chart" | "torrent" | "history" | "other";
  id?: string | number;
  name?: string;
  /** Extra query for endless contexts (wave settings). */
  params?: string;
  /** Link back to where playback started. */
  href?: string;
}

interface PlayerState {
  queue: Track[];
  index: number;
  playing: boolean;
  shuffle: boolean;
  repeat: Repeat;
  volume: number;
  muted: boolean;
  context: PlayContext | null;
}

interface TimeState {
  time: number;
  duration: number;
  buffering: boolean;
}

interface PlayerApi extends PlayerState {
  current: Track | null;
  autoplay: boolean;
  playList(tracks: Track[], start?: number, ctx?: PlayContext): void;
  toggle(): void;
  play(): void;
  pause(): void;
  next(): void;
  prev(): void;
  seek(sec: number): void;
  setVolume(v: number): void;
  toggleMute(): void;
  toggleShuffle(): void;
  cycleRepeat(): void;
  setAutoplay(on: boolean): void;
  addToQueue(tracks: Track[]): void;
  playNext(tracks: Track[]): void;
  removeAt(i: number): void;
  jumpTo(i: number): void;
  moveInQueue(from: number, to: number): void;
  reloadCurrent(): void;
  /** The track's source was changed (dialog): no cached / preloaded copy of the old one plays again. */
  sourceChanged(id: string): void;
  /** Swaps a track for another version of it wherever it is queued (a one-off source choice). */
  replaceTrack(id: string, t: Track): void;
  clearUpcoming(): void;
}

const PlayerCtx = createContext<PlayerApi | null>(null);
const TimeCtx = createContext<TimeState>({ time: 0, duration: 0, buffering: false });

export function usePlayer(): PlayerApi {
  const p = useContext(PlayerCtx);
  if (!p) throw new Error("PlayerProvider missing");
  return p;
}

export function useTime(): TimeState {
  return useContext(TimeCtx);
}

// Formats modern browsers play without help; others are transcoded.
const NATIVE = new Set(["flac", "mp3", "m4a", "aac", "ogg", "opus", "wav"]);
const STORE_KEY = "mm.player.v1";

function load<T>(key: string, def: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : def;
  } catch {
    return def;
  }
}

function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* quota / private mode */
  }
}

interface Saved {
  queue: Track[];
  index: number;
  time: number;
  shuffle: boolean;
  repeat: Repeat;
  volume: number;
  context: PlayContext | null;
  original: Track[] | null;
}

// The looped near-silent clip that keeps the element playing while a track resolves.
let silenceSrc: string | null = null;
function silence(): string {
  if (!silenceSrc) silenceSrc = URL.createObjectURL(new Blob([silenceWav() as BlobPart], { type: "audio/wav" }));
  return silenceSrc;
}

/** Lock screen / notification: title and cover, set as soon as a track is chosen. */
function setSessionMeta(t: Track | null) {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  if (!t) {
    ms.metadata = null;
    return;
  }
  if (ms.metadata && ms.metadata.title === t.title && ms.metadata.artist === t.artist) return;
  const art = t.coverBig ?? t.cover;
  ms.metadata = new MediaMetadata({
    title: t.title,
    artist: t.artist,
    album: t.album ?? "",
    artwork: art
      ? [
          { src: img(sized(art, 256)) ?? "", sizes: "256x256", type: "image/jpeg" },
          { src: img(sized(art, 512)) ?? "", sizes: "512x512", type: "image/jpeg" },
        ]
      : [],
  });
}

function shuffled<T>(a: T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j]!, b[i]!];
  }
  return b;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const saved = useMemo(() => load<Saved | null>(STORE_KEY, null), []);
  const [state, setState] = useState<PlayerState>(() => ({
    queue: saved?.queue ?? [],
    index: saved && saved.index < saved.queue.length ? saved.index : 0,
    playing: false,
    shuffle: saved?.shuffle ?? false,
    repeat: saved?.repeat ?? "off",
    volume: saved?.volume ?? 0.9,
    muted: false,
    context: saved?.context ?? null,
  }));
  const [time, setTime] = useState<TimeState>({ time: saved?.time ?? 0, duration: 0, buffering: false });
  const [autoplay, setAutoplayState] = useState<boolean>(() => load("mm.autoplay", true));

  const audioRef = useRef<HTMLAudioElement | null>(null);
  if (!audioRef.current && typeof Audio !== "undefined") {
    audioRef.current = new Audio();
    audioRef.current.preload = "auto";
  }
  // The next track is buffered in a second element and swapped in when it
  // starts, so it plays without waiting for the network.
  const preRef = useRef<HTMLAudioElement | null>(null);
  if (!preRef.current && typeof Audio !== "undefined") {
    preRef.current = new Audio();
    preRef.current.preload = "auto";
  }
  const preIdRef = useRef<string | null>(null);
  const starterRef = useRef<Starter | null>(null);
  if (!starterRef.current) starterRef.current = new Starter({ silence, fetchResolve: (p) => api.get(p) });
  const starter = starterRef.current;
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(audioRef.current);
  const stateRef = useRef(state);
  stateRef.current = state;
  const autoplayRef = useRef(autoplay);
  autoplayRef.current = autoplay;
  const originalRef = useRef<Track[] | null>(saved?.original ?? null); // order before shuffle
  const offsetRef = useRef(0); // transcoded streams start at this second
  const transcodingRef = useRef(false);
  const forcedTc = useRef(new Set<string>());
  const loadedIdRef = useRef<string | null>(null);
  // Resume position of a not-yet-loaded track (restored session or a seek before play).
  const restoreAtRef = useRef<{ id: string; at: number } | null>(
    saved && saved.queue[saved.index] ? { id: saved.queue[saved.index]!.id, at: saved.time } : null,
  );
  const reportedRef = useRef<string | null>(null);
  const prefetched = useRef(new Set<string>());
  const errorsRef = useRef(0);
  // Track that already asked the server for another source (once per load).
  const repickRef = useRef<string | null>(null);
  const extendingRef = useRef(false);
  const topUpRef = useRef<string | null>(null); // last track already topped up for
  // Source revision per track id: bumped by sourceChanged, part of the stream URL.
  const revRef = useRef(new Map<string, number>());
  const continuedRef = useRef(false); // «дальше — похожие» told once per list

  const current = state.queue[state.index] ?? null;

  // ---- loading ----

  const needsTc = (t: Track) =>
    !isDownloaded(t.id) &&
    !!t.src && (!!t.src.start || !!t.src.end || !NATIVE.has(t.src.ext) || forcedTc.current.has(t.id));

  // The server picks a track's source; with repick it drops the one it
  // served last (it failed here) and picks the next.
  const canRepick = (t: Track) => !isDownloaded(t.id) && (dzId(t) !== null || t.id.startsWith("yq:"));

  const srcFor = (t: Track, tc: boolean, at: number, repick = false): string => {
    if (isDownloaded(t.id)) return offlineUrl(t.id);
    const id = dzId(t);
    const rev = revRef.current.get(t.id);
    if (id !== null) return withRev(`/music/api/play/${id}${repick ? "?repick=1" : ""}`, rev);
    if (t.id.startsWith("yt:")) return `/music/api/yt/${t.id.slice(3)}`;
    if (t.id.startsWith("zv:")) return `/music/api/zv/${t.id.slice(3)}`;
    if (t.id.startsWith("yq:")) {
      const q = new URLSearchParams({ id: t.id, artist: t.artist, title: t.title, duration: String(t.duration || 0) });
      if (repick) q.set("repick", "1");
      return withRev(`/music/api/ytq?${q}`, rev);
    }
    if (t.src) {
      const base = `/music/api/stream/${t.src.hash}/${t.src.file}`;
      if (!tc) return `${base}?ext=${encodeURIComponent(t.src.ext)}`;
      const q = new URLSearchParams({ tc: "1" });
      if (t.src.start) q.set("start", String(t.src.start));
      if (t.src.end) q.set("end", String(t.src.end));
      if (at > 0) q.set("t", at.toFixed(2));
      return `${base}?${q}`;
    }
    return "";
  };

  // Refused play(): in the background it is retried when the page is shown
  // again (see the visibility effect), in front the button shows "play".
  const playFailed = (e: unknown) => {
    if (e instanceof DOMException && e.name === "NotAllowedError" && !document.hidden) {
      setState((s) => ({ ...s, playing: false }));
    }
  };
  const playNow = (a: HTMLAudioElement) => {
    a.play().catch(playFailed);
  };

  const loadTrack = useCallback((t: Track, autoplayNow: boolean, at = 0, repick = false) => {
    let audio = audioRef.current;
    if (!audio) return;
    starter.cancel();
    if (!repick) repickRef.current = null;
    const tc = needsTc(t);
    transcodingRef.current = tc;
    offsetRef.current = tc ? at : 0;
    loadedIdRef.current = t.id;
    const pre = preRef.current;
    // Only a preload with a known length: a live-converted stream (torrent
    // FLAC/CUE behind /play) has none and no Range, so after sitting paused it
    // played the few seconds it had buffered and stopped. Those open fresh.
    // Hidden page (screen off): keep the element that is already playing.
    // Mobile browsers may refuse play() on the spare one in the background,
    // so it only warms the cache there.
    if (!repick && pre && preIdRef.current === t.id && !tc && at === 0 && !document.hidden && pre.src && !pre.error && Number.isFinite(pre.duration)) {
      // Swap in the preloaded element.
      const old = audio;
      old.pause();
      old.loop = false;
      old.removeAttribute("src");
      old.load();
      pre.volume = old.volume;
      pre.muted = old.muted;
      audioRef.current = pre;
      preRef.current = old;
      preIdRef.current = null;
      audio = pre;
      setAudioEl(pre);
      if (autoplayNow) playNow(audio);
    } else {
      if (pre && preIdRef.current === t.id) {
        // Its preload isn't used: stop it (no second download / converter).
        pre.removeAttribute("src");
        pre.load();
        preIdRef.current = null;
      }
      // Resolve first (silence meanwhile) only for a fresh start of a track
      // the server still has to find; seeks and repicks go straight there.
      const resolve = !repick && !tc && at === 0 && !isDownloaded(t.id) ? resolvePath(t) : null;
      const el = audio;
      if (!tc && at > 0) {
        const onMeta = () => {
          el.currentTime = at;
          el.removeEventListener("loadedmetadata", onMeta);
        };
        el.addEventListener("loadedmetadata", onMeta);
      }
      void starter.start(el, { resolve, src: srcFor(t, tc, at, repick), autoplay: autoplayNow, onPlayError: playFailed });
    }
    setTime({ time: at, duration: t.duration || 0, buffering: autoplayNow });
    if (autoplayNow) {
      setSessionMeta(t);
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load whenever the current track changes (and playback is wanted).
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    if (loadedIdRef.current === current.id) return;
    if (!state.playing) return; // restored queue: load on first play
    reportedRef.current = null;
    loadTrack(current, true, 0);
  }, [current, state.playing, loadTrack]);

  // ---- queue operations ----

  // Starts the track right away, in the same task (e.g. the "ended" event):
  // with the screen off a page whose audio has stopped gets throttled or
  // frozen, so waiting for a render + effect left the next track silent.
  const setIndex = useCallback((i: number, playing = true, queue?: Track[]) => {
    const t = (queue ?? stateRef.current.queue)[i];
    if (playing && t) {
      reportedRef.current = null;
      restoreAtRef.current = null;
      loadTrack(t, true, 0);
    }
    setState((s) => ({ ...s, index: i, playing }));
  }, [loadTrack]);

  const playList = useCallback(
    (tracks: Track[], start = 0, ctx?: PlayContext) => {
      if (tracks.length === 0) return;
      errorsRef.current = 0;
      continuedRef.current = false;
      const s = stateRef.current;
      let queue = tracks;
      let index = Math.max(0, Math.min(start, tracks.length - 1));
      originalRef.current = null;
      if (s.shuffle) {
        originalRef.current = tracks;
        const first = tracks[index]!;
        queue = [first, ...shuffled(tracks.filter((_, i) => i !== index))];
        index = 0;
      }
      const target = queue[index]!;
      // Same track already loaded: just restart it.
      if (loadedIdRef.current === target.id) loadedIdRef.current = null;
      setState((st) => ({ ...st, queue, index, playing: true, context: ctx ?? null }));
    },
    [],
  );

  const play = useCallback(() => {
    const audio = audioRef.current;
    const s = stateRef.current;
    const t = s.queue[s.index];
    if (!audio || !t) return;
    if (loadedIdRef.current !== t.id) {
      const r = restoreAtRef.current;
      loadTrack(t, true, r && r.id === t.id ? r.at : 0);
      restoreAtRef.current = null;
      setState((st) => ({ ...st, playing: true }));
      return;
    }
    audio.play().catch(() => undefined);
    setState((st) => ({ ...st, playing: true }));
  }, [loadTrack]);

  const pause = useCallback(() => {
    // Paused while still resolving: drop the start, play() loads it again.
    if (starter.warm) {
      starter.cancel();
      loadedIdRef.current = null;
    }
    audioRef.current?.pause();
    setState((st) => ({ ...st, playing: false }));
  }, []);

  const toggle = useCallback(() => {
    if (stateRef.current.playing) pause();
    else play();
  }, [play, pause]);

  // Endless contexts and "autoplay": add more tracks near the end.
  const extend = useCallback(async (): Promise<Track[] | null> => {
    if (extendingRef.current) return null;
    const s = stateRef.current;
    const last = s.queue[s.queue.length - 1];
    if (!last) return null;
    const ctx = s.context;
    let load: (() => Promise<Track[]>) | null = null;
    // A finite list (album, playlist, AI / imported playlist, search…) goes on
    // with recommendations made from the list itself.
    let continuing = false;
    if (ctx?.type === "flow") {
      const recent = s.queue.slice(-60).map((t) => t.id).join(",");
      const path = `/flow?${ctx.id ? `artist=${ctx.id}&` : ""}${ctx.params ? `${ctx.params}&` : ""}exclude=${encodeURIComponent(recent)}`;
      load = () => api.get<Track[]>(path);
    } else if (ctx?.type === "radio" && ctx.id) {
      load = () => api.get<Track[]>(`/artist/${ctx.id}/radio`);
    } else if (autoplayRef.current) {
      continuing = true;
      load = () => api.post<Track[]>("/continue", continueBody(s.queue));
    }
    if (!load) return null;
    extendingRef.current = true;
    try {
      const more = await load();
      const have = new Set(stateRef.current.queue.map((t) => t.id));
      const fresh = more.filter((t) => !have.has(t.id));
      if (fresh.length === 0) return null;
      const queue = [...stateRef.current.queue, ...fresh];
      stateRef.current = { ...stateRef.current, queue }; // read before the next render
      setState((st) => ({ ...st, queue: [...st.queue, ...fresh] }));
      if (continuing && !continuedRef.current) {
        continuedRef.current = true;
        toast("Дальше — похожие треки");
      }
      return queue;
    } catch {
      return null;
    } finally {
      extendingRef.current = false;
    }
  }, []);

  const next = useCallback(
    (auto = false) => {
      const s = stateRef.current;
      if (s.index + 1 < s.queue.length) {
        setIndex(s.index + 1);
        return;
      }
      if (s.repeat === "all" && s.queue.length > 0) {
        setIndex(0);
        return;
      }
      void extend().then((queue) => {
        if (queue) setIndex(stateRef.current.index + 1, true, queue);
        else if (auto) setState((st) => ({ ...st, playing: false }));
      });
    },
    [setIndex, extend],
  );

  const seek = useCallback(
    (sec: number) => {
      const audio = audioRef.current;
      const s = stateRef.current;
      const t = s.queue[s.index];
      if (!audio || !t) return;
      sec = Math.max(0, sec);
      if (starter.warm) return; // still resolving: nothing to seek in yet
      if (loadedIdRef.current !== t.id) {
        restoreAtRef.current = { id: t.id, at: sec };
        setTime((x) => ({ ...x, time: sec }));
        return;
      }
      if (transcodingRef.current) {
        loadTrack(t, s.playing, sec);
      } else {
        audio.currentTime = sec;
        setTime((x) => ({ ...x, time: sec }));
      }
    },
    [loadTrack],
  );

  const prev = useCallback(() => {
    const s = stateRef.current;
    const audio = audioRef.current;
    const pos = (audio?.currentTime ?? 0) + offsetRef.current;
    if (pos > 3 || s.index === 0) {
      seek(0);
      if (!s.playing) play();
      return;
    }
    setIndex(s.index - 1);
  }, [seek, play, setIndex]);

  const reloadCurrent = useCallback(() => {
    const s = stateRef.current;
    const t = s.queue[s.index];
    if (!t) return;
    const pos = (audioRef.current?.currentTime ?? 0) + offsetRef.current;
    loadTrack(t, true, pos > 1 ? pos : 0);
    setState((st) => ({ ...st, playing: true }));
  }, [loadTrack]);

  const sourceChanged = useCallback((id: string) => {
    revRef.current.set(id, Date.now());
    prefetched.current.delete(id);
    const pre = preRef.current;
    if (pre && preIdRef.current === id) {
      pre.removeAttribute("src");
      pre.load();
      preIdRef.current = null;
    }
    const s = stateRef.current;
    if (s.queue[s.index]?.id === id) reloadCurrent();
  }, [reloadCurrent]);

  const replaceTrack = useCallback((id: string, nt: Track) => {
    const s = stateRef.current;
    if (!s.queue.some((t) => t.id === id)) {
      playList([nt], 0, { type: "other", name: nt.title });
      return;
    }
    const swap = (q: Track[]) => q.map((t) => (t.id === id ? nt : t));
    if (originalRef.current) originalRef.current = swap(originalRef.current);
    const queue = swap(s.queue);
    const isCur = s.queue[s.index]?.id === id;
    stateRef.current = { ...s, queue };
    if (preIdRef.current === id && preRef.current) {
      preRef.current.removeAttribute("src");
      preRef.current.load();
      preIdRef.current = null;
    }
    if (isCur) {
      reportedRef.current = null;
      loadTrack(nt, true, 0);
    }
    setState((st) => ({ ...st, queue: swap(st.queue), playing: isCur ? true : st.playing }));
  }, [playList, loadTrack]);

  const addToQueue = useCallback((tracks: Track[]) => {
    if (tracks.length === 0) return;
    setState((s) => ({ ...s, queue: s.queue.length === 0 ? tracks : [...s.queue, ...tracks] }));
    toast(tracks.length === 1 ? "Добавлено в очередь" : `В очередь: ${tracks.length}`);
  }, []);

  const playNext = useCallback((tracks: Track[]) => {
    if (tracks.length === 0) return;
    setState((s) => {
      if (s.queue.length === 0) return { ...s, queue: tracks, index: 0 };
      const q = [...s.queue];
      q.splice(s.index + 1, 0, ...tracks);
      return { ...s, queue: q };
    });
    toast("Будет играть следующим");
  }, []);

  const removeAt = useCallback((i: number) => {
    setState((s) => {
      if (i === s.index || i < 0 || i >= s.queue.length) return s;
      const q = s.queue.filter((_, k) => k !== i);
      return { ...s, queue: q, index: i < s.index ? s.index - 1 : s.index };
    });
  }, []);

  const moveInQueue = useCallback((from: number, to: number) => {
    setState((s) => {
      if (from === to || from < 0 || to < 0 || from >= s.queue.length || to >= s.queue.length) return s;
      const q = [...s.queue];
      const [t] = q.splice(from, 1);
      q.splice(to, 0, t!);
      let index = s.index;
      if (from === s.index) index = to;
      else if (from < s.index && to >= s.index) index--;
      else if (from > s.index && to <= s.index) index++;
      return { ...s, queue: q, index };
    });
  }, []);

  const clearUpcoming = useCallback(() => {
    setState((s) => ({ ...s, queue: s.queue.slice(0, s.index + 1) }));
  }, []);

  const jumpTo = useCallback((i: number) => setIndex(i), [setIndex]);

  const toggleShuffle = useCallback(() => {
    setState((s) => {
      const cur = s.queue[s.index];
      if (!cur) return { ...s, shuffle: !s.shuffle };
      if (!s.shuffle) {
        originalRef.current = s.queue;
        const rest = shuffled(s.queue.filter((_, i) => i !== s.index));
        return { ...s, shuffle: true, queue: [cur, ...rest], index: 0 };
      }
      const orig = originalRef.current;
      originalRef.current = null;
      if (orig) {
        // Keep tracks added meanwhile.
        const inOrig = new Set(orig.map((t) => t.id));
        const extra = s.queue.filter((t) => !inOrig.has(t.id));
        const q = [...orig, ...extra];
        const idx = Math.max(0, q.findIndex((t) => t.id === cur.id));
        return { ...s, shuffle: false, queue: q, index: idx };
      }
      return { ...s, shuffle: false };
    });
  }, []);

  const cycleRepeat = useCallback(() => {
    setState((s) => ({ ...s, repeat: s.repeat === "off" ? "all" : s.repeat === "all" ? "one" : "off" }));
  }, []);

  const setVolume = useCallback((v: number) => {
    const vol = Math.max(0, Math.min(1, v));
    if (audioRef.current) audioRef.current.volume = vol;
    setState((s) => ({ ...s, volume: vol, muted: vol === 0 ? s.muted : false }));
  }, []);

  const toggleMute = useCallback(() => {
    setState((s) => ({ ...s, muted: !s.muted }));
  }, []);

  const setAutoplay = useCallback((on: boolean) => {
    setAutoplayState(on);
    save("mm.autoplay", on);
  }, []);

  // ---- audio element events ----

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = state.volume;
    audio.muted = state.muted;
  }, [state.volume, state.muted, audioEl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let lastPos = 0;
    const pos = () => audio.currentTime + offsetRef.current;
    const dur = () => {
      const s = stateRef.current;
      const t = s.queue[s.index];
      if (!transcodingRef.current && isFinite(audio.duration) && audio.duration > 0) return audio.duration;
      return t?.duration ?? 0;
    };
    const onTime = () => {
      if (audio !== audioRef.current || starter.warm) return;
      const p = pos();
      const d = dur();
      setTime((x) => (Math.abs(x.time - p) < 0.25 && x.duration === d && !x.buffering ? x : { time: p, duration: d, buffering: false }));
      // History: counted after 30 s (or half of a short track).
      const s = stateRef.current;
      const t = s.queue[s.index];
      if (t && reportedRef.current !== t.id && p >= Math.min(30, (d || 60) / 2)) {
        reportedRef.current = t.id;
        errorsRef.current = 0;
        api.post("/history", t).catch(() => undefined);
      }
      // Next tracks: matched and cached on the server, and the very next
      // one buffered in the spare audio element.
      if (t && p > 3) {
        // (catalog and imported ones: the next start then needs no silence)
        for (const nxt of s.queue.slice(s.index + 1, s.index + 3)) {
          if (!isDownloaded(nxt.id) && !prefetched.current.has(nxt.id)) {
            prefetched.current.add(nxt.id);
            starter.prefetch(resolvePath(nxt)).catch(() => prefetched.current.delete(nxt.id));
          }
        }
        const nxt = s.queue[s.index + 1];
        const pre = preRef.current;
        if (nxt && pre && preIdRef.current !== nxt.id && nxt.id !== t.id && !needsTc(nxt)) {
          preIdRef.current = nxt.id;
          pre.src = srcFor(nxt, false, 0);
          pre.load();
          // Not preloadable (no length, no Range — see loadTrack): drop it
          // at once, which also frees the server's converter for the swap.
          const id = nxt.id;
          const onMeta = () => {
            pre.removeEventListener("loadedmetadata", onMeta);
            if (preIdRef.current === id && preRef.current === pre && !Number.isFinite(pre.duration)) {
              pre.removeAttribute("src");
              pre.load();
            }
          };
          pre.addEventListener("loadedmetadata", onMeta);
        }
        // Endless contexts: top up when 3 tracks are left.
        if ((s.context?.type === "flow" || s.context?.type === "radio") && s.queue.length - s.index <= 3) void extend();
        // Autoplay: fetch more during the last track, not after it ended
        // (a page with the screen off may not get to run the request).
        else if (s.index === s.queue.length - 1 && s.repeat === "off" && d > 0 && d - p < 40 && topUpRef.current !== t.id) {
          topUpRef.current = t.id;
          void extend();
        }
      }
      if ("mediaSession" in navigator && Math.abs(p - lastPos) > 4 && d > 0) {
        lastPos = p;
        try {
          navigator.mediaSession.setPositionState({ duration: d, position: Math.min(p, d), playbackRate: 1 });
        } catch {
          /* old browsers */
        }
      }
    };
    const onWaiting = () => audio === audioRef.current && !starter.warm && setTime((x) => ({ ...x, buffering: true }));
    const onPlaying = () => {
      if (audio !== audioRef.current) return;
      if (!starter.warm) setTime((x) => ({ ...x, buffering: false }));
      setState((s) => (s.playing ? s : { ...s, playing: true }));
    };
    const onPause = () => {
      if (audio !== audioRef.current) return;
      // Stale: a src swap pauses the element, play() was called right after.
      if (!audio.paused) return;
      if (starter.warm) {
        // The OS stopped the silence (a call…): don't start the track later.
        starter.cancel();
        loadedIdRef.current = null;
      }
      if (!audio.ended) setState((s) => (s.playing ? { ...s, playing: false } : s));
    };
    const onEnded = () => {
      if (audio !== audioRef.current || starter.warm) return;
      const s = stateRef.current;
      if (s.repeat === "one") {
        seek(0);
        audio.play().catch(() => undefined);
        return;
      }
      next(true);
    };
    const onError = () => {
      if (audio !== audioRef.current || starter.warm) return;
      const s = stateRef.current;
      const t = s.queue[s.index];
      if (!t || !audio.src || loadedIdRef.current !== t.id) return;
      // Torrent file the browser can't decode: transcode from here on.
      if (t.src && !transcodingRef.current) {
        forcedTc.current.add(t.id);
        loadTrack(t, true, pos());
        return;
      }
      // This source can't play (dead zaycev link, vanished upload…): once,
      // let the server pick another one and go on from the same spot.
      if (canRepick(t) && repickRef.current !== t.id) {
        repickRef.current = t.id;
        const at = pos();
        loadTrack(t, true, at > 1 ? at : 0, true);
        return;
      }
      errorsRef.current++;
      setTime((x) => ({ ...x, buffering: false }));
      if (errorsRef.current >= 3) {
        toast("Не получается воспроизвести — источник недоступен");
        setState((st) => ({ ...st, playing: false }));
        errorsRef.current = 0;
        return;
      }
      toast(`Не удалось воспроизвести «${t.title}», дальше`);
      // Screen off: right away (a silent page may be frozen before a timer fires).
      if (document.hidden) next(true);
      else setTimeout(() => next(true), 900);
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
  }, [next, seek, loadTrack, extend, audioEl]);

  // ---- Media Session (lock screen, headphones, media keys) ----

  useEffect(() => {
    setSessionMeta(current);
    if (current) document.title = `${current.title} — ${current.artist}`;
  }, [current]);

  // Back on screen: a start the browser refused in the background plays now.
  useEffect(() => {
    const onVis = () => {
      const audio = audioRef.current;
      const s = stateRef.current;
      const t = s.queue[s.index];
      if (document.hidden || !audio || !t || !s.playing || starter.warm) return;
      if (loadedIdRef.current === t.id && audio.paused && !audio.ended && audio.src) audio.play().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [starter]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = state.playing ? "playing" : "paused";
  }, [state.playing]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(a, h);
      } catch {
        /* unsupported action */
      }
    };
    set("play", () => play());
    set("pause", () => pause());
    set("nexttrack", () => next());
    set("previoustrack", () => prev());
    set("seekto", (d) => d.seekTime !== undefined && seek(d.seekTime));
    set("seekbackward", (d) => seek((audioRef.current?.currentTime ?? 0) + offsetRef.current - (d.seekOffset ?? 10)));
    set("seekforward", (d) => seek((audioRef.current?.currentTime ?? 0) + offsetRef.current + (d.seekOffset ?? 10)));
  }, [play, pause, next, prev, seek]);

  // ---- persistence ----

  const timeRef = useRef(time.time);
  timeRef.current = time.time;
  useEffect(() => {
    const persist = () => {
      const s = stateRef.current;
      // Keep the stored queue bounded around the current track.
      const from = Math.max(0, s.index - 50);
      const queue = s.queue.slice(from, from + 300);
      save(STORE_KEY, {
        queue,
        index: s.index - from,
        time: timeRef.current,
        shuffle: s.shuffle,
        repeat: s.repeat,
        volume: s.volume,
        context: s.context,
        original: originalRef.current && originalRef.current.length <= 300 ? originalRef.current : null,
      } satisfies Saved);
    };
    const id = setInterval(persist, 5000);
    window.addEventListener("pagehide", persist);
    persist();
    return () => {
      clearInterval(id);
      window.removeEventListener("pagehide", persist);
    };
  }, [state.queue, state.index, state.shuffle, state.repeat, state.volume, state.context]);

  // ---- keyboard ----

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const pos = (audioRef.current?.currentTime ?? 0) + offsetRef.current;
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (e.code === "ArrowRight" && e.shiftKey) next();
      else if (e.code === "ArrowLeft" && e.shiftKey) prev();
      else if (e.code === "ArrowRight") seek(pos + 10);
      else if (e.code === "ArrowLeft") seek(pos - 10);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, next, prev, seek]);

  const value = useMemo<PlayerApi>(
    () => ({
      ...state,
      current,
      autoplay,
      playList,
      toggle,
      play,
      pause,
      next: () => next(false),
      prev,
      seek,
      setVolume,
      toggleMute,
      toggleShuffle,
      cycleRepeat,
      setAutoplay,
      addToQueue,
      playNext,
      removeAt,
      jumpTo,
      moveInQueue,
      reloadCurrent,
      sourceChanged,
      replaceTrack,
      clearUpcoming,
    }),
    [state, current, autoplay, playList, toggle, play, pause, next, prev, seek, setVolume, toggleMute, toggleShuffle, cycleRepeat,
      setAutoplay, addToQueue, playNext, removeAt, jumpTo, moveInQueue, reloadCurrent, sourceChanged, replaceTrack, clearUpcoming],
  );

  return (
    <PlayerCtx.Provider value={value}>
      <TimeCtx.Provider value={time}>{children}</TimeCtx.Provider>
    </PlayerCtx.Provider>
  );
}

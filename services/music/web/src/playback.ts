// Starting a track so it also plays with the screen off.
//
// A catalog / imported track's stream (/play, /ytq) only answers once the
// server has found a recording — YouTube search plus probing, often 5–20 s.
// Mobile browsers don't start playback for a hidden page that isn't playing
// already: switching the screen off in that window left the track silent
// (Chrome defers it until the page is shown, iOS suspends the page). So the
// player first plays a looped near-silent clip on its one audio element
// (in the tap, which also unlocks the element), asks the server to resolve
// the track with a plain fetch, and only then points the element at the
// real stream: to the browser that is an element that keeps playing.
//
// Pure logic (no React, no DOM globals) so it is unit-tested in Node.

import type { Track } from "./api";

/** The bits of an <audio> element the starter touches. */
export interface AudioLike {
  src: string;
  loop: boolean;
  play(): Promise<void>;
}

/** Where the server resolves a track ahead of playback (null: nothing to resolve). */
export function resolvePath(t: Pick<Track, "id" | "artist" | "title" | "duration">): string | null {
  if (/^dz:\d+$/.test(t.id)) return `/resolve/${t.id.slice(3)}`;
  if (t.id.startsWith("yq:")) {
    const q = new URLSearchParams({ id: t.id, artist: t.artist, title: t.title, duration: String(t.duration || 0) });
    return `/resolveq?${q}`;
  }
  return null;
}

export interface StartOpts {
  /** Server-side resolve to wait for first (null: none). */
  resolve: string | null;
  /** The real stream URL. */
  src: string;
  autoplay: boolean;
  /** Called right after the real src is set (before play()). */
  onReal?: () => void;
  /** play() of the real stream failed. */
  onPlayError?: (e: unknown) => void;
}

export interface StarterDeps {
  /** URL of the looped silent clip. */
  silence: () => string;
  /** Resolves when the server has the track ready (rejection = go anyway; the stream falls back). */
  fetchResolve: (path: string) => Promise<unknown>;
  /** Longest wait for a resolve before trying the stream anyway. */
  timeoutMs?: number;
}

/** Sequences track starts: [silence while resolving] → real stream. */
export class Starter {
  /** Playing the silent clip: the element's events aren't the track's. */
  warm = false;
  private seq = 0;
  /** Resolve paths the server already answered (prefetch, earlier plays). */
  private readyPaths = new Set<string>();
  private inflight = new Map<string, Promise<unknown>>();

  private deps: StarterDeps;

  constructor(deps: StarterDeps) {
    this.deps = deps;
  }

  isReady(path: string | null): boolean {
    return path === null || this.readyPaths.has(path);
  }

  /** Resolve ahead (next tracks); shares one request per path. */
  prefetch(path: string | null): Promise<unknown> {
    if (path === null || this.readyPaths.has(path)) return Promise.resolve();
    let p = this.inflight.get(path);
    if (!p) {
      p = this.deps.fetchResolve(path).then(
        (v) => {
          this.readyPaths.add(path);
          if (this.readyPaths.size > 500) this.readyPaths.clear();
          return v;
        },
      );
      p.finally(() => this.inflight.delete(path)).catch(() => undefined);
      this.inflight.set(path, p);
    }
    return p;
  }

  /** Drops a pending start (another track, pause before it began). */
  cancel() {
    this.seq++;
    this.warm = false;
  }

  /**
   * Starts a track on audio. Returns true when the real src was set, false
   * when a later start or cancel() superseded this one.
   */
  async start(audio: AudioLike, o: StartOpts): Promise<boolean> {
    const my = ++this.seq;
    if (o.autoplay && !this.isReady(o.resolve)) {
      this.warm = true;
      audio.loop = true;
      audio.src = this.deps.silence();
      audio.play().catch(() => undefined);
      // A network wait, not a timer chain: it isn't throttled with the screen off.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise((resolve) => (timer = setTimeout(resolve, this.deps.timeoutMs ?? 45_000)));
      try {
        await Promise.race([this.prefetch(o.resolve), timeout]);
      } catch {
        /* the stream itself falls back (zaycev, trackers) or reports the error */
      } finally {
        clearTimeout(timer);
      }
      if (my !== this.seq) return false;
    }
    this.warm = false;
    audio.loop = false;
    audio.src = o.src;
    o.onReal?.();
    if (o.autoplay) audio.play().catch((e: unknown) => o.onPlayError?.(e));
    return true;
  }
}

/** A mono 16-bit WAV of near-silence (±1 LSB noise: some browsers treat digital zero as "not playing"). */
export function silenceWav(seconds = 2, rate = 8000): Uint8Array {
  const n = Math.round(seconds * rate);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, i % 2 ? 1 : -1, true);
  return new Uint8Array(buf);
}

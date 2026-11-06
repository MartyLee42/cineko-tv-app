// «Уютный режим» sound: rain or a fireplace synthesised with the Web Audio
// API (no audio files): looped coloured-noise beds through filters plus
// short noise bursts scheduled a little ahead (raindrops / crackles). Quiet,
// fades in and out. Browsers only start audio after a user gesture, so
// useCozySound waits for the first click / tap / key press (a remote's
// key counts on TV).
import { useEffect } from "react";
import { AMBIENCE_MIX, COZY_FADE_IN, COZY_FADE_OUT, COZY_VOLUME, fillNoise, scheduleBursts, type CozyAmbience } from "./cozy";

type AC = typeof AudioContext;

function audioContextClass(): AC | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AC; webkitAudioContext?: AC };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export interface CozySoundHandle {
  /** Resumes a context the browser started suspended (call from a gesture). */
  resume(): void;
  running(): boolean;
  stop(): void;
}

/** Starts the ambience's sound (null without Web Audio). */
export function startCozySound(ambience: Exclude<CozyAmbience, "off">): CozySoundHandle | null {
  const Ctor = audioContextClass();
  if (!Ctor) return null;
  let ctx: AudioContext;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  const mix = AMBIENCE_MIX[ambience];
  const master = ctx.createGain();
  master.gain.setValueAtTime(0, ctx.currentTime);
  master.gain.linearRampToValueAtTime(COZY_VOLUME, ctx.currentTime + COZY_FADE_IN);
  master.connect(ctx.destination);
  const sources: AudioScheduledSourceNode[] = [];

  const noiseBuffer = (seconds: number, color: "white" | "pink" | "brown") => {
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    fillNoise(buf.getChannelData(0), color);
    return buf;
  };

  for (const bed of mix.beds) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(4, bed.color);
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = bed.highpass;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = bed.lowpass;
    const g = ctx.createGain();
    g.gain.value = bed.gain;
    src.connect(hp);
    hp.connect(lp);
    lp.connect(g);
    g.connect(master);
    if (bed.swell) {
      // A slow LFO on the bed's gain: the rain gusts, the fire breathes.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = bed.swell.rate;
      const depth = ctx.createGain();
      depth.gain.value = bed.gain * bed.swell.depth;
      lfo.connect(depth);
      depth.connect(g.gain);
      lfo.start();
      sources.push(lfo);
    }
    src.start();
    sources.push(src);
  }

  // Bursts: one shared white-noise grain, band-passed and enveloped per event.
  const grain = noiseBuffer(0.12, "white");
  const lookahead = 0.6;
  let nexts = mix.bursts.map(() => ctx.currentTime + 0.3);
  const tick = () => {
    if (ctx.state !== "running") return;
    const until = ctx.currentTime + lookahead;
    nexts = mix.bursts.map((b, i) => {
      const { events, next } = scheduleBursts(b, Math.max(nexts[i]!, ctx.currentTime), until);
      for (const e of events) {
        const src = ctx.createBufferSource();
        src.buffer = grain;
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = e.freq;
        bp.Q.value = b.q;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, e.at);
        env.gain.linearRampToValueAtTime(e.gain, e.at + 0.002);
        env.gain.exponentialRampToValueAtTime(0.0001, e.at + e.dur);
        src.connect(bp);
        bp.connect(env);
        env.connect(master);
        src.start(e.at);
        src.stop(e.at + e.dur + 0.02);
      }
      return next;
    });
  };
  const timer = setInterval(tick, 250);
  tick();

  let stopped = false;
  return {
    resume() {
      if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    },
    running: () => ctx.state === "running",
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      const now = ctx.currentTime;
      try {
        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(master.gain.value, now);
        master.gain.linearRampToValueAtTime(0, now + COZY_FADE_OUT);
      } catch {
        // closed already
      }
      setTimeout(() => {
        for (const s of sources) {
          try {
            s.stop();
          } catch {
            // never started
          }
        }
        void ctx.close().catch(() => undefined);
      }, COZY_FADE_OUT * 1000 + 50);
    },
  };
}

const GESTURES = ["pointerdown", "touchend", "keydown", "click"] as const;

/** True once the page has had a user gesture (audio may start without waiting). */
function hadGesture(): boolean {
  const ua = (typeof navigator !== "undefined" ? (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation : undefined) ?? null;
  return !!ua?.hasBeenActive;
}

/**
 * Plays the ambience while `enabled` (the caller folds in cozy_sound, Home,
 * playback and the hidden page). Starts on the first user gesture if the
 * page hasn't had one yet; stops (with a short fade) when disabled or
 * unmounted.
 */
export function useCozySound(ambience: CozyAmbience, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || ambience === "off") return;
    const which = ambience;
    let handle: CozySoundHandle | null = null;
    let done = false;
    const off = () => GESTURES.forEach((e) => window.removeEventListener(e, onGesture, true));
    function onGesture() {
      if (done) return;
      if (!handle) handle = startCozySound(which);
      handle?.resume();
      if (!handle || handle.running()) off();
    }
    GESTURES.forEach((e) => window.addEventListener(e, onGesture, true));
    if (hadGesture()) onGesture();
    return () => {
      done = true;
      off();
      handle?.stop();
    };
  }, [ambience, enabled]);
}

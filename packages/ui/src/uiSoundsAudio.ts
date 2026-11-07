// Plays interface sounds (uiSounds.ts recipes) with the Web Audio API, like
// cozy mode: synthesised, no audio files. The context is created lazily on
// the first sound — always inside a key / click handler, so the browser's
// autoplay policy allows it — and reused. Silent while a film or song plays.
import { getAppliedDesign } from "./designs";
import { makeThrottle, recipeLength, uiSoundForKey, uiSoundRecipe, uiSoundsPref, UI_SOUND_VOLUME, UI_TICK_EVERY_MS, type SoundRecipe, type UiSoundKind } from "./uiSounds";

type AC = typeof AudioContext;

let ctx: AudioContext | null = null;
let noiseBuf: AudioBuffer | null = null;
const tickGate = makeThrottle(UI_TICK_EVERY_MS);

function context(): AudioContext | null {
  if (ctx) return ctx;
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AC; webkitAudioContext?: AC };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

/** A film, a trailer or a song is playing: stay quiet. */
function mediaPlaying(): boolean {
  if (typeof document === "undefined") return false;
  const els = document.querySelectorAll("video, audio");
  for (let i = 0; i < els.length; i++) {
    const m = els[i] as HTMLMediaElement;
    if (!m.paused && !m.ended) return true;
  }
  return false;
}

/** Plays `kind` in the applied design's character (if sounds are on). */
export function playUiSound(kind: UiSoundKind): void {
  if (!uiSoundsPref.get()) return;
  if (kind === "tick" && !tickGate(Date.now())) return;
  if (mediaPlaying()) return;
  playRecipe(uiSoundRecipe(getAppliedDesign(), kind));
}

/**
 * A loading style's own cue (the odyssey's note, a dropped egg's «хрусь»):
 * only when «Звуки интерфейса» is on; plays over a film that just started.
 */
export function playLoaderSound(r: SoundRecipe): void {
  if (!uiSoundsPref.get()) return;
  playRecipe(r);
}

function playRecipe(r: SoundRecipe): void {
  const c = context();
  if (!c) return;
  if (c.state === "suspended") void c.resume().catch(() => undefined);
  const t0 = c.currentTime + 0.005;
  try {
    const master = c.createGain();
    master.gain.value = UI_SOUND_VOLUME;
    master.connect(c.destination);
    for (const v of r.tones) {
      const o = c.createOscillator();
      o.type = v.wave;
      o.frequency.setValueAtTime(v.from, t0 + v.at);
      if (v.to !== v.from) o.frequency.exponentialRampToValueAtTime(Math.max(1, v.to), t0 + v.at + v.dur);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t0 + v.at);
      g.gain.exponentialRampToValueAtTime(v.gain, t0 + v.at + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + v.at + v.dur);
      o.connect(g);
      g.connect(master);
      o.start(t0 + v.at);
      o.stop(t0 + v.at + v.dur + 0.01);
    }
    if (r.noise.length) {
      if (!noiseBuf) {
        noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.1), c.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      for (const v of r.noise) {
        const s = c.createBufferSource();
        s.buffer = noiseBuf;
        const f = c.createBiquadFilter();
        f.type = v.filter;
        f.frequency.value = v.freq;
        f.Q.value = v.q;
        const g = c.createGain();
        g.gain.setValueAtTime(v.gain, t0 + v.at);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + v.at + v.dur);
        s.connect(f);
        f.connect(g);
        g.connect(master);
        s.start(t0 + v.at);
        s.stop(t0 + v.at + v.dur + 0.01);
      }
    }
    // Let the graph go once the sound is over.
    setTimeout(() => master.disconnect(), (recipeLength(r) + 0.1) * 1000);
  } catch {
    /* an old engine without some node type: no sound */
  }
}

/**
 * TV remotes: a tick on arrows, a click on OK (capture phase, never
 * stopping the key). Returns the uninstaller.
 */
export function installKeySounds(target: Window = window): () => void {
  const onKey = (e: KeyboardEvent) => {
    const kind = uiSoundForKey(e.key);
    if (kind) playUiSound(kind);
  };
  target.addEventListener("keydown", onKey, true);
  return () => target.removeEventListener("keydown", onKey, true);
}

/** PWA: a click on buttons and links (one delegated listener). Returns the uninstaller. */
export function installClickSounds(target: Document = document): () => void {
  const onClick = (e: MouseEvent) => {
    const el = e.target as Element | null;
    if (el && typeof el.closest === "function" && el.closest("button, a[href], [role='button'], [role='tab'], [role='switch'], summary")) playUiSound("click");
  };
  target.addEventListener("click", onClick, true);
  return () => target.removeEventListener("click", onClick, true);
}

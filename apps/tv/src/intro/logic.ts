// When the startup intro plays (once per app start) and the TV's on/off
// choice for it (Settings → «Анимация при запуске», device-local).
import { storage } from "../platform";

const KEY = "martytv.startup_intro";

/** This TV's choice (default on). */
export const introPref = {
  get(): boolean {
    return storage.get(KEY) !== "0";
  },
  set(on: boolean) {
    storage.set(KEY, on ? "1" : "0");
  },
};

/** Total length of every intro (ms) before it fades out, and the fade. */
export const INTRO_MS = 3000;
export const INTRO_FADE_MS = 450;

export interface IntroEnv {
  /** The Settings choice. */
  enabled: boolean;
  /** The OS asks for less motion. */
  reducedMotion: boolean;
  /** Automated browser (tests): skipped unless forced. */
  webdriver: boolean;
  /** `?intro=1` in the URL (tests / previews): play even under webdriver. */
  forced: boolean;
}

export function shouldShowIntro(e: IntroEnv): boolean {
  if (e.forced) return e.enabled;
  return e.enabled && !e.reducedMotion && !e.webdriver;
}

/** The environment of this page load. */
export function introEnv(): IntroEnv {
  let reducedMotion: boolean;
  try {
    reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    reducedMotion = false;
  }
  const params = new URLSearchParams(location.search || location.hash.split("?")[1] || "");
  return {
    enabled: introPref.get(),
    reducedMotion,
    webdriver: typeof navigator !== "undefined" && !!navigator.webdriver,
    forced: params.get("intro") === "1",
  };
}

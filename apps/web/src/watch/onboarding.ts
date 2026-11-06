// First-run setup guide: step logic and what to save at the end.
import type { Profile } from "@martytv/contracts";
import type { Preferences } from "../play/prefs";
import type { Settings, SettingsPatch } from "./settings";

export const STEPS = ["look", "profile", "playback", "content", "loading", "done"] as const;
export type Step = (typeof STEPS)[number];

export function nextStep(s: Step): Step {
  return STEPS[Math.min(STEPS.indexOf(s) + 1, STEPS.length - 1)]!;
}
export function prevStep(s: Step): Step {
  return STEPS[Math.max(STEPS.indexOf(s) - 1, 0)]!;
}
export function stepNumber(s: Step): number {
  return STEPS.indexOf(s) + 1;
}

const FORCE_KEY = "martytv.onboarding.force";

/**
 * Show the guide when the active profile's (loaded) settings say it hasn't
 * been completed. Automated browsers (navigator.webdriver) skip it unless a
 * test opts in via localStorage, so unrelated end-to-end flows aren't blocked.
 */
export function shouldShowOnboarding(
  settings: Pick<Settings, "onboarding_completed"> | undefined,
  env: { webdriver: boolean; forced: boolean },
): boolean {
  if (!settings || settings.onboarding_completed === true) return false;
  return !env.webdriver || env.forced;
}

export function onboardingEnv(): { webdriver: boolean; forced: boolean } {
  let forced = false;
  try {
    forced = localStorage.getItem(FORCE_KEY) === "1";
  } catch {
    // storage unavailable
  }
  return { webdriver: typeof navigator !== "undefined" && navigator.webdriver === true, forced };
}

export interface ProfileDraft {
  name: string;
  avatar: string;
  color: string;
}
export type PrefsDraft = Pick<
  Preferences,
  "preferred_audio_languages" | "preferred_voiceovers" | "preferred_resolution" | "max_size_gb"
>;

export interface SavePlan {
  settings: SettingsPatch & { onboarding_completed: true };
  /** Only the changed profile fields (null = no PATCH). */
  profile: Partial<ProfileDraft> | null;
  /** Full preferences body (null = unchanged, no PUT). */
  prefs: Preferences | null;
}

/** What Finish/Skip writes: changed settings + completed flag, changed profile fields, merged prefs. */
export function buildSavePlan(input: {
  settings: SettingsPatch;
  profile: ProfileDraft;
  initialProfile: Pick<Profile, "name" | "avatar" | "color">;
  prefs: PrefsDraft | null;
  initialPrefs: Preferences | undefined;
}): SavePlan {
  const p = input.profile;
  const ip = input.initialProfile;
  const changed: Partial<ProfileDraft> = {};
  const name = p.name.trim();
  if (name && name !== ip.name) changed.name = name;
  if (p.avatar !== ip.avatar) changed.avatar = p.avatar;
  if (p.color !== ip.color) changed.color = p.color;

  let prefs: Preferences | null = null;
  if (input.prefs && input.initialPrefs) {
    const merged: Preferences = { ...input.initialPrefs, ...input.prefs };
    if (JSON.stringify(merged) !== JSON.stringify(input.initialPrefs)) prefs = merged;
  }
  return {
    settings: { ...input.settings, onboarding_completed: true },
    profile: Object.keys(changed).length ? changed : null,
    prefs,
  };
}

// ---------------------------------------------------------------- PWA install

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;

/** Captures `beforeinstallprompt` (Android/desktop Chrome) for an "Install" button later. */
export function captureInstallPrompt() {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
  });
}

export function canPromptInstall(): boolean {
  return deferred != null;
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const e = deferred;
  deferred = null;
  await e.prompt();
  return (await e.userChoice).outcome === "accepted";
}

/** "ios" → show the Share → Add to Home Screen hint; null when installed or not applicable. */
export function installHint(ua: string, standalone: boolean, canPrompt: boolean): "prompt" | "ios" | null {
  if (standalone) return null;
  if (canPrompt) return "prompt";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  return null;
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches);
}

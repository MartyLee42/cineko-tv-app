// «Установить приложение»: Chrome/Edge/Android fire `beforeinstallprompt`
// (often only once, and a dismissed mini-infobar stays hidden for months), so
// the event is captured as early as possible and offered from our own UI.
// iOS Safari has no prompt at all: we show the Share → «На экран „Домой“» steps.
import { useSyncExternalStore } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function initInstall() {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // keep it for our button instead of the one-time infobar
    deferred = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    emit();
  });
}

export type Platform = "ios" | "android" | "desktop";

export function detectInstallPlatform(ua: string, maxTouchPoints = 0): Platform {
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && maxTouchPoints > 1)) return "ios";
  if (/android/i.test(ua)) return "android";
  return "desktop";
}

/** Running as an installed app (home-screen / standalone window). */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

export interface InstallState {
  /** Hide all install UI: already installed / running as the app. */
  installed: boolean;
  /** The browser's own install dialog is available (Chrome/Edge/Android). */
  canPrompt: boolean;
  platform: Platform;
}

let snapshot: InstallState | null = null;
function read(): InstallState {
  const next: InstallState = {
    installed: installed || isStandalone(),
    canPrompt: !!deferred,
    platform: typeof navigator === "undefined" ? "desktop" : detectInstallPlatform(navigator.userAgent, navigator.maxTouchPoints),
  };
  if (!snapshot || snapshot.installed !== next.installed || snapshot.canPrompt !== next.canPrompt || snapshot.platform !== next.platform) snapshot = next;
  return snapshot;
}

export function useInstall(): InstallState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    read,
  );
}

/** Opens the browser's install dialog; true when the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  await e.prompt();
  const choice = await e.userChoice;
  deferred = null;
  emit();
  return choice.outcome === "accepted";
}

const BANNER_KEY = "martytv.install_banner_dismissed";
export function bannerDismissed(): boolean {
  try {
    return localStorage.getItem(BANNER_KEY) === "1";
  } catch {
    return true;
  }
}
export function dismissBanner() {
  try {
    localStorage.setItem(BANNER_KEY, "1");
  } catch {
    // ignore
  }
}

/** Whether the install UI makes sense here (not installed; a prompt or iOS steps exist). */
export function offerInstall(s: InstallState): boolean {
  return !s.installed && (s.canPrompt || s.platform === "ios");
}

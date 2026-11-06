// TV platform helpers: remote keys, persistent storage, exit behaviour.
import { leaveThroughTrap } from "./remote/backTrap";

/** Back/Return key codes across TV platforms. */
const BACK_KEYS = new Set([
  8, // Backspace (browsers, some Android TV remotes)
  27, // Escape
  461, // LG webOS Back
  10009, // Samsung Tizen Return
  166, // BrowserBack
]);

export function isBackKey(e: KeyboardEvent): boolean {
  if (e.key === "GoBack" || e.key === "BrowserBack" || e.key === "Escape") return true;
  // Backspace inside a text field edits text; it is not "back".
  if (e.keyCode === 8 && isTextInput(e.target)) return false;
  return BACK_KEYS.has(e.keyCode);
}

function isTextInput(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
}

export function detectPlatform(): string {
  const ua = navigator.userAgent;
  if (/Tizen/i.test(ua)) return "tizen";
  if (/Web0S|webOS/i.test(ua)) return "webos";
  if (/Android/i.test(ua)) return "android-tv";
  if (/MSX|Media Station/i.test(ua)) return "msx";
  return "browser";
}

export function defaultDeviceName(): string {
  const p = detectPlatform();
  return p === "browser" ? "Browser TV" : `${p[0]!.toUpperCase()}${p.slice(1)} TV`;
}

/** Hosted by Media Station X (its UA, or the MSX bridge's live heartbeat)? */
function hostedByMsx(): boolean {
  if (/MSX|Media ?Station/i.test(navigator.userAgent)) return true;
  try {
    const at = (JSON.parse(localStorage.getItem("martytv.msx_bridge") ?? "null") as { alive_at?: number } | null)?.alive_at;
    return typeof at === "number" && Math.abs(Date.now() - at) <= 15_000;
  } catch {
    return false;
  }
}

/**
 * Leaves the app (only after the «Выйти из Cineko?» confirm). Under Media
 * Station X the TV app runs as a linked page: going back in history returns
 * to MSX — never the host app's own exit, which on a Samsung closed MSX
 * itself («back closes everything»). Native wrappers expose their own exit.
 */
export function exitApp(): void {
  const w = window as unknown as {
    tizen?: { application: { getCurrentApplication(): { exit(): void } } };
    webOS?: { platformBack(): void };
  };
  if (!hostedByMsx()) {
    try {
      if (w.tizen) return w.tizen.application.getCurrentApplication().exit();
      if (w.webOS) return w.webOS.platformBack();
    } catch {
      // fall through to history
    }
  }
  // TV hosts: the Back trap holds a history entry of its own.
  if (leaveThroughTrap()) return;
  if (history.length > 1) history.back();
  else window.close();
}

// ---- storage ----
// TV browsers occasionally disable localStorage (or wipe it); keep an
// in-memory fallback so the app still works for the session.

const memory = new Map<string, string>();

export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  },
  set(key: string, value: string): void {
    memory.set(key, value);
    try {
      localStorage.setItem(key, value);
    } catch {
      // memory only
    }
  },
  remove(key: string): void {
    memory.delete(key);
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

const CREDENTIAL_KEY = "martytv.device_credential";
const PROFILE_KEY = "martytv.profile_id";

export const credentialStore = {
  get: () => storage.get(CREDENTIAL_KEY),
  set: (v: string) => storage.set(CREDENTIAL_KEY, v),
  clear: () => {
    storage.remove(CREDENTIAL_KEY);
    storage.remove(PROFILE_KEY);
  },
};

export const profileStore = {
  get: () => storage.get(PROFILE_KEY),
  set: (v: string) => storage.set(PROFILE_KEY, v),
  clear: () => storage.remove(PROFILE_KEY),
};

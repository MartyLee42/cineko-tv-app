// The two stored language inputs of a device and what they resolve to
// (precedence in localeDetect.ts). Pure apart from the storage it's given,
// so I18nProvider and the tests share it.
import { asLocale, LOCALE_KEY, PROFILE_LOCALE_KEY, resolveLocale, type Locale } from "./localeDetect";

export interface KeyValueStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** localStorage, or nothing (private mode, tests without a DOM). */
function safe<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

export function browserStore(): KeyValueStore {
  return {
    getItem: (k) => safe(() => localStorage.getItem(k), null),
    setItem: (k, v) => safe(() => localStorage.setItem(k, v), undefined),
    removeItem: (k) => safe(() => localStorage.removeItem(k), undefined),
  };
}

export interface LocaleChoice {
  /** This device's own choice (null: follows the profile / browser). */
  device(): Locale | null;
  /** The profile's language as last seen here (null: not chosen / unknown). */
  profile(): Locale | null;
  /** What to show now. */
  resolved(): Locale;
  /** An explicit pick on this device. */
  chooseHere(l: Locale): Locale;
  /** Forget this device's pick (follow the profile again). */
  clearHere(): Locale;
  /** The profile's ui_language arrived ("" / null: not chosen). Cached for the next start. */
  setProfile(v: string | null | undefined): Locale;
}

export function createLocaleChoice(store: KeyValueStore, nav?: string): LocaleChoice {
  const device = () => asLocale(store.getItem(LOCALE_KEY));
  const profile = () => asLocale(store.getItem(PROFILE_LOCALE_KEY));
  const resolved = () => resolveLocale(device(), profile(), nav);
  return {
    device,
    profile,
    resolved,
    chooseHere(l) {
      store.setItem(LOCALE_KEY, l);
      return resolved();
    },
    clearHere() {
      store.removeItem(LOCALE_KEY);
      return resolved();
    },
    setProfile(v) {
      const p = asLocale(v);
      if (p) store.setItem(PROFILE_LOCALE_KEY, p);
      else store.removeItem(PROFILE_LOCALE_KEY);
      return resolved();
    },
  };
}

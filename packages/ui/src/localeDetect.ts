// Which language the app starts in. Tiny on purpose: the TV's entry module
// uses it (via localePreload.ts) without pulling in the rest of @martytv/ui.
//
// Precedence (highest first):
//   1. this device's own choice — the language picker in this browser, or
//      the TV's own «Язык» option (LOCALE_KEY);
//   2. the profile's ui_language (server; cached in PROFILE_LOCALE_KEY so the
//      next start opens in it before the profile loads);
//   3. the browser's / TV's language.

export type Locale = "en" | "ru" | "kk";

/** This device's own choice (written only by an explicit pick). */
export const LOCALE_KEY = "martytv.locale";
/** The last profile language seen here: a cache of the profile's ui_language. */
export const PROFILE_LOCALE_KEY = "martytv.locale.profile";

export function asLocale(v: unknown): Locale | null {
  return v === "en" || v === "ru" || v === "kk" ? v : null;
}

/** The browser's / TV's own language. */
export function navigatorLocale(nav: string = typeof navigator !== "undefined" ? navigator.language : "en"): Locale {
  const n = (nav || "en").toLowerCase();
  return n.startsWith("ru") ? "ru" : n.startsWith("kk") ? "kk" : "en";
}

/** Device choice > profile language > browser language (invalid values are skipped). */
export function resolveLocale(device: unknown, profile: unknown, nav?: string): Locale {
  return asLocale(device) ?? asLocale(profile) ?? navigatorLocale(nav);
}

/** Back-compat: the stored device choice, else the browser's language. */
export function detectLocale(stored?: string | null, profile?: string | null): Locale {
  return resolveLocale(stored, profile);
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readStoredLocale(): string | null {
  return read(LOCALE_KEY);
}

export function readProfileLocale(): string | null {
  return read(PROFILE_LOCALE_KEY);
}

/** The language this device starts in. */
export function startLocale(): Locale {
  return resolveLocale(readStoredLocale(), readProfileLocale());
}

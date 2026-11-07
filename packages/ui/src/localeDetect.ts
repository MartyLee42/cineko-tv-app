// Which language the app starts in. Tiny on purpose: the TV's entry module
// uses it (via localePreload.ts) without pulling in the rest of @martytv/ui.

export type Locale = "en" | "ru";

export const LOCALE_KEY = "martytv.locale";

export function detectLocale(stored?: string | null): Locale {
  if (stored === "en" || stored === "ru") return stored;
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  return nav.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export function readStoredLocale(): string | null {
  try {
    return localStorage.getItem(LOCALE_KEY);
  } catch {
    return null;
  }
}

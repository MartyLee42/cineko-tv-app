// Which language the app starts in. Tiny on purpose: the TV's entry module
// uses it (via localePreload.ts) without pulling in the rest of @martytv/ui.

export type Locale = "en" | "ru" | "kk";

export const LOCALE_KEY = "martytv.locale";

export function detectLocale(stored?: string | null): Locale {
  if (stored === "en" || stored === "ru" || stored === "kk") return stored;
  const nav = (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase();
  return nav.startsWith("ru") ? "ru" : nav.startsWith("kk") ? "kk" : "en";
}

export function readStoredLocale(): string | null {
  try {
    return localStorage.getItem(LOCALE_KEY);
  } catch {
    return null;
  }
}

// Starts downloading the start language's strings right away (the TV's entry
// calls it next to `import("./boot")`, so both travel in parallel). The same
// modules as i18n.tsx's loadLocale(): that call then finds them in flight.
import { detectLocale, readStoredLocale } from "./localeDetect";

export function preloadLocale(): void {
  const p = detectLocale(readStoredLocale()) === "en" ? import("./locales/all.en") : import("./locales/all.ru");
  p.catch(() => undefined); // loadLocale() retries and reports
}

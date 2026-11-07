// Starts downloading the start language's strings right away (the TV's entry
// calls it next to `import("./boot")`, so both travel in parallel). The same
// modules as i18n.tsx's loadLocale(): that call then finds them in flight.
import { detectLocale, readStoredLocale } from "./localeDetect";

export function preloadLocale(): void {
  const l = detectLocale(readStoredLocale());
  const p = l === "en" ? import("./locales/all.en") : l === "kk" ? import("./locales/all.kk") : import("./locales/all.ru");
  p.catch(() => undefined); // loadLocale() retries and reports
}

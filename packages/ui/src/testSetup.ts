import { loadLocale } from "./i18n";

await Promise.all([loadLocale("ru"), loadLocale("en")]);

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useAppliedDesign } from "./designs";
import { en as coreEn } from "./locales/en";
import { ru as coreRu } from "./locales/ru";
import { catalogEn } from "./locales/catalog.en";
import { catalogRu } from "./locales/catalog.ru";
import { remoteEn } from "./locales/remote.en";
import { remoteRu } from "./locales/remote.ru";
import { playerEn } from "./locales/player.en";
import { playerRu } from "./locales/player.ru";
import { settingsEn } from "./locales/settings.en";
import { settingsRu } from "./locales/settings.ru";
import { tvdesignEn } from "./locales/tvdesign.en";
import { tvdesignRu } from "./locales/tvdesign.ru";
import { errorsEn } from "./locales/errors.en";
import { errorsRu } from "./locales/errors.ru";
import { adminEn } from "./locales/admin.en";
import { adminRu } from "./locales/admin.ru";
import { sourcesEn } from "./locales/sources.en";
import { sourcesRu } from "./locales/sources.ru";
import { importsEn } from "./locales/imports.en";
import { importsRu } from "./locales/imports.ru";
import { onlineEn } from "./locales/online.en";
import { onlineRu } from "./locales/online.ru";
import { foryouEn } from "./locales/foryou.en";
import { foryouRu } from "./locales/foryou.ru";
import { askEn } from "./locales/ask.en";
import { askRu } from "./locales/ask.ru";
import { tasteEn } from "./locales/taste.en";
import { tasteRu } from "./locales/taste.ru";
import { downloadsEn } from "./locales/downloads.en";
import { downloadsRu } from "./locales/downloads.ru";
import { iptvEn } from "./locales/iptv.en";
import { iptvRu } from "./locales/iptv.ru";
import { videoEn } from "./locales/video.en";
import { videoRu } from "./locales/video.ru";
import { newEpisodesEn } from "./locales/newepisodes.en";
import { newEpisodesRu } from "./locales/newepisodes.ru";
import { seasonsEn } from "./locales/seasons.en";
import { seasonsRu } from "./locales/seasons.ru";
import { designsEn } from "./locales/designs.en";
import { designsRu } from "./locales/designs.ru";
import { tvplayEn } from "./locales/tvplay.en";
import { tvplayRu } from "./locales/tvplay.ru";
import { playerStatsEn } from "./locales/playerstats.en";
import { playerStatsRu } from "./locales/playerstats.ru";
import { martyEn } from "./locales/marty.en";
import { martyRu } from "./locales/marty.ru";
import { devprefsEn } from "./locales/devprefs.en";
import { devprefsRu } from "./locales/devprefs.ru";
import { superplayEn } from "./locales/superplay.en";
import { superplayRu } from "./locales/superplay.ru";
import { tasteQuizEn } from "./locales/tastequiz.en";
import { tasteQuizRu } from "./locales/tastequiz.ru";
import { cozyEn } from "./locales/cozy.en";
import { cozyRu } from "./locales/cozy.ru";
import { curatedEn } from "./locales/curated.en";
import { curatedRu } from "./locales/curated.ru";
import { awardsEn } from "./locales/awards.en";
import { awardsRu } from "./locales/awards.ru";
import { idleEn } from "./locales/idle.en";
import { idleRu } from "./locales/idle.ru";
import { healthEn } from "./locales/health.en";
import { healthRu } from "./locales/health.ru";
import { mascotEn } from "./locales/mascot.en";
import { mascotRu } from "./locales/mascot.ru";

const en = { ...coreEn, ...catalogEn, ...remoteEn, ...playerEn, ...settingsEn, ...adminEn, ...tvdesignEn, ...errorsEn, ...sourcesEn, ...importsEn, ...onlineEn, ...foryouEn, ...askEn, ...tasteEn, ...downloadsEn, ...iptvEn, ...designsEn, ...videoEn, ...seasonsEn, ...tvplayEn, ...playerStatsEn, ...devprefsEn, ...superplayEn, ...newEpisodesEn, ...tasteQuizEn, ...cozyEn, ...martyEn, ...healthEn, ...curatedEn, ...awardsEn, ...idleEn, ...mascotEn };
const ru = { ...coreRu, ...catalogRu, ...remoteRu, ...playerRu, ...settingsRu, ...adminRu, ...tvdesignRu, ...errorsRu, ...sourcesRu, ...importsRu, ...onlineRu, ...foryouRu, ...askRu, ...tasteRu, ...downloadsRu, ...iptvRu, ...designsRu, ...videoRu, ...seasonsRu, ...tvplayRu, ...playerStatsRu, ...devprefsRu, ...superplayRu, ...newEpisodesRu, ...tasteQuizRu, ...cozyRu, ...martyRu, ...healthRu, ...curatedRu, ...awardsRu, ...idleRu, ...mascotRu };
export type MessageKey = keyof typeof en;

export type Locale = "en" | "ru";
export const LOCALES: Locale[] = ["en", "ru"];

const dictionaries: Record<Locale, Record<MessageKey, string>> = { en, ru };

/** Replaces {name} placeholders. Unknown placeholders are left visible. */
export function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function translate(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  return format(dictionaries[locale][key] ?? en[key] ?? key, vars);
}

/** Strings «Конструктивизм» says differently: the AI is «Товарищ ЭВМ» («Comrade Computer»). */
export const CV_MESSAGES: Record<Locale, Partial<Record<MessageKey, string>>> = {
  ru: {
    "ask.title": "Спросите Товарища ЭВМ",
    "ask.subtitle": "Электронный советчик Госкино. Опишите, что хочется посмотреть, — ЭВМ подберёт фильмы и сериалы из каталога.",
    "ask.ai": "ЭВМ",
    "ask.thinking": "Товарищ ЭВМ думает…",
    "ask.thinking_hint": "Перфокарты пробиты, лампы греются — ответ будет в течение полуминуты.",
    "ask.card.title": "Товарищ ЭВМ",
    "ask.card.text": "Электронный советчик Госкино: опишите, что хочется посмотреть, — и получите совет.",
    "ask.tv.short": "Товарищ ЭВМ",
    "ask.err.disabled_title": "Товарищ ЭВМ на ремонте",
    "ask.err.failed": "Товарищ ЭВМ сейчас не ответил. Попробуйте ещё раз.",
    "ask.err.limit": "Вопросы к Товарищу ЭВМ на сегодня закончились. Новые — завтра.",
    "ask.err.budget": "У Товарища ЭВМ закончился дневной лимит. Попробуйте завтра.",
    "catalog.ai.mode": "ЭВМ",
    "catalog.ai.send": "Спросить ЭВМ",
    "catalog.ai.suggest": "Спросить Товарища ЭВМ: «{q}»",
  },
  en: {
    "ask.title": "Ask Comrade Computer",
    "ask.subtitle": "The Goskino electronic adviser. Describe what you feel like watching — it picks real titles from the catalog.",
    "ask.ai": "Computer",
    "ask.thinking": "Comrade Computer is thinking…",
    "ask.card.title": "Comrade Computer",
    "ask.tv.short": "Computer",
    "catalog.ai.mode": "Computer",
    "catalog.ai.send": "Ask the Computer",
    "catalog.ai.suggest": "Ask Comrade Computer: “{q}”",
  },
};

/** `translate` with the «Конструктивизм» wording. */
export function translateCv(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  const cv = CV_MESSAGES[locale][key];
  return cv === undefined ? translate(locale, key, vars) : format(cv, vars);
}

export function detectLocale(stored?: string | null): Locale {
  if (stored === "en" || stored === "ru") return stored;
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  return nav.toLowerCase().startsWith("ru") ? "ru" : "en";
}

type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: TFn;
}

const I18nContext = createContext<I18nValue | null>(null);

const STORAGE_KEY = "martytv.locale";

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale(readStored()));
  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // storage unavailable (private mode); keep in memory only
    }
    document.documentElement.lang = l;
  }, []);
  // «Конструктивизм» renames a few strings (the AI is «Товарищ ЭВМ»).
  const cv = useAppliedDesign() === "constructivism";
  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale, t: cv ? (key, vars) => translateCv(locale, key, vars) : (key, vars) => translate(locale, key, vars) }),
    [locale, setLocale, cv],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Like useI18n, but null outside an I18nProvider (for components used everywhere, e.g. the mascot). */
export function useI18nOptional(): I18nValue | null {
  return useContext(I18nContext);
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) throw new Error("useI18n must be used inside I18nProvider");
  return v;
}


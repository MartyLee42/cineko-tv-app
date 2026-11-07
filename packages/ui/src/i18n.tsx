import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAppliedDesign } from "./designs";
import { detectLocale, LOCALE_KEY as STORAGE_KEY, readStoredLocale as readStored, type Locale } from "./localeDetect";

export { detectLocale, type Locale };

export type MessageKey = keyof typeof import("./locales/all.en").messagesEn;

export const LOCALES: Locale[] = ["en", "ru"];

type Dict = Record<MessageKey, string>;

// The strings of one language are a separate chunk (~150 KB of JS each):
// only the active one is downloaded. Apps call loadLocale() before the first
// render (in parallel with their own code); translate() is synchronous.
const dictionaries: Partial<Record<Locale, Dict>> = {};
const loaders: Record<Locale, () => Promise<Dict>> = {
  en: () => import("./locales/all.en").then((m) => m.messagesEn),
  ru: () => import("./locales/all.ru").then((m) => m.messagesRu),
};
const loading: Partial<Record<Locale, Promise<void>>> = {};

/** Downloads a language's strings (once; a failed load is retried on the next call). */
export function loadLocale(l: Locale): Promise<void> {
  if (dictionaries[l]) return Promise.resolve();
  return (loading[l] ??= loaders[l]().then(
    (d) => {
      dictionaries[l] = d;
    },
    (e: unknown) => {
      delete loading[l];
      throw e;
    },
  ));
}

/** The language's strings are here (translate() can use them). */
export function localeLoaded(l: Locale): boolean {
  return !!dictionaries[l];
}

/** Replaces {name} placeholders. Unknown placeholders are left visible. */
export function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function translate(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  // A key missing in one language (or a language not loaded yet) falls back to the other.
  return format(dictionaries[locale]?.[key] ?? dictionaries.ru?.[key] ?? dictionaries.en?.[key] ?? key, vars);
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


type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: TFn;
}

const I18nContext = createContext<I18nValue | null>(null);


/** The language this browser starts in (stored choice, else the browser's). Entry points preload it. */
export function initialLocale(): Locale {
  return detectLocale(readStored());
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  // Bumped when a language's strings arrive (normally they're loaded before the first render).
  const [loaded, setLoaded] = useState(0);
  useEffect(() => {
    if (localeLoaded(locale)) return;
    let live = true;
    loadLocale(locale).then(
      () => live && setLoaded((n) => n + 1),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [locale]);
  const setLocale = useCallback((l: Locale) => {
    const apply = () => {
      setLocaleState(l);
      try {
        localStorage.setItem(STORAGE_KEY, l);
      } catch {
        // storage unavailable (private mode); keep in memory only
      }
      document.documentElement.lang = l;
    };
    // Switch once the other language's strings are here (no flash of keys).
    if (localeLoaded(l)) apply();
    else loadLocale(l).then(apply, () => undefined);
  }, []);
  // «Конструктивизм» renames a few strings (the AI is «Товарищ ЭВМ»).
  const cv = useAppliedDesign() === "constructivism";
  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale, t: cv ? (key, vars) => translateCv(locale, key, vars) : (key, vars) => translate(locale, key, vars) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `loaded`: new strings arrived
    [locale, setLocale, cv, loaded],
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


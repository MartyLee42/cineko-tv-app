import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAppliedDesign } from "./designs";
import { detectLocale, startLocale, type Locale } from "./localeDetect";
import { browserStore, createLocaleChoice } from "./localeChoice";
import { reportChunkFailure } from "./chunkReload";

export { detectLocale, type Locale };
export { asLocale, resolveLocale } from "./localeDetect";

export type MessageKey = keyof typeof import("./locales/all.en").messagesEn;

export const LOCALES: Locale[] = ["en", "ru", "kk"];

/** Each language's own name, for the language pickers. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", ru: "Русский", kk: "Қазақша" };

type Dict = Record<MessageKey, string>;

// The strings of one language are a separate chunk (~150 KB of JS each):
// only the active one is downloaded. Apps call loadLocale() before the first
// render (in parallel with their own code); translate() is synchronous.
const dictionaries: Partial<Record<Locale, Dict>> = {};
const loaders: Record<Locale, () => Promise<Dict>> = {
  en: () => import("./locales/all.en").then((m) => m.messagesEn),
  ru: () => import("./locales/all.ru").then((m) => m.messagesRu),
  kk: () => import("./locales/all.kk").then((m) => m.messagesKk),
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
      reportChunkFailure(e);
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
  kk: {
    "ask.title": "Жолдас ЭЕМ-нен сұраңыз",
    "ask.ai": "ЭЕМ",
    "ask.thinking": "Жолдас ЭЕМ ойланып жатыр…",
    "ask.card.title": "Жолдас ЭЕМ",
    "ask.tv.short": "ЭЕМ",
    "catalog.ai.mode": "ЭЕМ",
    "catalog.ai.send": "ЭЕМ-нен сұрау",
    "catalog.ai.suggest": "Жолдас ЭЕМ-нен сұрау: «{q}»",
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
  /** An explicit pick on this device (wins over the profile's language). */
  setLocale: (l: Locale) => void;
  /** The active profile's ui_language arrived ("" / null: not chosen): applied unless this device chose. */
  setProfileLocale: (l: string | null | undefined) => void;
  /** Forget this device's pick: follow the profile's language (else the browser's). */
  clearDeviceLocale: () => void;
  /** This device's own pick, null when it follows the profile / browser. */
  deviceLocale: Locale | null;
  /** The profile's language as last seen here (null: not chosen). */
  profileLocale: Locale | null;
  t: TFn;
}

const I18nContext = createContext<I18nValue | null>(null);

/**
 * The language this device starts in: its own pick, else the profile's
 * (cached from the last session), else the browser's. Entry points preload it.
 */
export function initialLocale(): Locale {
  return startLocale();
}

let shown: Locale | null = null;
/** The language on screen now (for the API's X-Cineko-Language header). */
export function currentLocale(): Locale {
  return (shown ??= initialLocale());
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const choice = useMemo(() => createLocaleChoice(browserStore()), []);
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [inputs, setInputs] = useState(() => ({ device: choice.device(), profile: choice.profile() }));
  // Bumped when a language's strings arrive (normally they're loaded before the first render).
  const [loaded, setLoaded] = useState(0);
  useEffect(() => {
    shown = locale;
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
  // The latest requested language: a slower earlier load never overrides it.
  const want = useRef<Locale>(locale);
  const show = useCallback(
    (l: Locale) => {
      want.current = l;
      setInputs({ device: choice.device(), profile: choice.profile() });
      const apply = () => {
        if (want.current !== l) return;
        shown = l;
        setLocaleState(l);
        document.documentElement.lang = l;
      };
      // Switch once the other language's strings are here (no flash of keys).
      if (localeLoaded(l)) apply();
      else loadLocale(l).then(apply, () => undefined);
    },
    [choice],
  );
  const setLocale = useCallback((l: Locale) => show(choice.chooseHere(l)), [choice, show]);
  const setProfileLocale = useCallback((l: string | null | undefined) => show(choice.setProfile(l)), [choice, show]);
  const clearDeviceLocale = useCallback(() => show(choice.clearHere()), [choice, show]);
  // «Конструктивизм» renames a few strings (the AI is «Товарищ ЭВМ»).
  const cv = useAppliedDesign() === "constructivism";
  const value = useMemo<I18nValue>(
    () => ({
      locale,
      setLocale,
      setProfileLocale,
      clearDeviceLocale,
      deviceLocale: inputs.device,
      profileLocale: inputs.profile,
      t: cv ? (key, vars) => translateCv(locale, key, vars) : (key, vars) => translate(locale, key, vars),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `loaded`: new strings arrived
    [locale, setLocale, setProfileLocale, clearDeviceLocale, inputs, cv, loaded],
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


/**
 * Country names for ISO 3166-1 codes (title pages: «США, Великобритания»).
 * Uses Intl.DisplayNames where the engine has it; old TV engines (Chrome 53)
 * don't, so the common production countries are built in for ru/en.
 */
const NAMES: Record<string, [ru: string, en: string]> = {
  US: ["США", "USA"],
  GB: ["Великобритания", "UK"],
  RU: ["Россия", "Russia"],
  SU: ["СССР", "USSR"],
  FR: ["Франция", "France"],
  DE: ["Германия", "Germany"],
  IT: ["Италия", "Italy"],
  ES: ["Испания", "Spain"],
  CA: ["Канада", "Canada"],
  AU: ["Австралия", "Australia"],
  NZ: ["Новая Зеландия", "New Zealand"],
  IE: ["Ирландия", "Ireland"],
  JP: ["Япония", "Japan"],
  KR: ["Южная Корея", "South Korea"],
  CN: ["Китай", "China"],
  HK: ["Гонконг", "Hong Kong"],
  TW: ["Тайвань", "Taiwan"],
  IN: ["Индия", "India"],
  TH: ["Таиланд", "Thailand"],
  TR: ["Турция", "Turkey"],
  BR: ["Бразилия", "Brazil"],
  MX: ["Мексика", "Mexico"],
  AR: ["Аргентина", "Argentina"],
  SE: ["Швеция", "Sweden"],
  NO: ["Норвегия", "Norway"],
  DK: ["Дания", "Denmark"],
  FI: ["Финляндия", "Finland"],
  IS: ["Исландия", "Iceland"],
  NL: ["Нидерланды", "Netherlands"],
  BE: ["Бельгия", "Belgium"],
  CH: ["Швейцария", "Switzerland"],
  AT: ["Австрия", "Austria"],
  PL: ["Польша", "Poland"],
  CZ: ["Чехия", "Czechia"],
  HU: ["Венгрия", "Hungary"],
  UA: ["Украина", "Ukraine"],
  BY: ["Беларусь", "Belarus"],
  KZ: ["Казахстан", "Kazakhstan"],
  GE: ["Грузия", "Georgia"],
  IL: ["Израиль", "Israel"],
  IR: ["Иран", "Iran"],
  EG: ["Египет", "Egypt"],
  ZA: ["ЮАР", "South Africa"],
  GR: ["Греция", "Greece"],
  PT: ["Португалия", "Portugal"],
  RO: ["Румыния", "Romania"],
  CO: ["Колумбия", "Colombia"],
  CL: ["Чили", "Chile"],
  ID: ["Индонезия", "Indonesia"],
  PH: ["Филиппины", "Philippines"],
};

type DisplayNamesCtor = new (locales: string[], opts: { type: "region" }) => { of(code: string): string | undefined };

const cache = new Map<string, { of(code: string): string | undefined } | null>();

function displayNames(locale: string) {
  if (!cache.has(locale)) {
    const DN = (Intl as unknown as { DisplayNames?: DisplayNamesCtor }).DisplayNames;
    let dn: { of(code: string): string | undefined } | null;
    try {
      dn = DN ? new DN([locale], { type: "region" }) : null;
    } catch {
      dn = null;
    }
    cache.set(locale, dn);
  }
  return cache.get(locale) ?? null;
}

/** One country's name; the built-in list wins for short forms (США, UK). */
export function countryName(code: string, locale: string): string {
  const c = code.toUpperCase();
  const ru = locale.startsWith("ru");
  const known = NAMES[c];
  if (locale.startsWith("kk")) return displayNames("kk")?.of(c) ?? (known ? known[0] : (displayNames("ru")?.of(c) ?? c));
  if (known) return ru ? known[0] : known[1];
  return displayNames(ru ? "ru" : "en")?.of(c) ?? c;
}

/** «США, Великобритания» — at most `max` countries, then «…». */
export function countryList(codes: readonly string[] | null | undefined, locale: string, max = 3): string | null {
  if (!codes || codes.length === 0) return null;
  const names = [...new Set(codes)].slice(0, max).map((c) => countryName(c, locale));
  return names.join(", ") + (codes.length > max ? "…" : "");
}

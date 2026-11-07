import type { devprefsEn } from "./devprefs.en";

// kk mirrors devprefs.en.ts key for key.
export const devprefsKk: Record<keyof typeof devprefsEn, string> = {
  "devprefs.this_browser_hint": "Осы браузерде көргенде таратуларды іріктеу: ажыратымдылық, битрейт, кодектер. Автоматты мәндер — браузердің өзі анықтағаны.",
  "devprefs.sheet_title": "Ойнату баптаулары",
  "devprefs.sheet_subtitle": "{name} · осы ТВ үшін таратуларды іріктеу",
  "devprefs.open": "Ойнату баптаулары",
  "devprefs.suggest_title": "Әлсіз құрылғыға ұқсайды — пресетті қолдану керек пе?",
  "devprefs.browsers": "Сіздің браузерлеріңіз",
  "devprefs.browsers_hint": "Cineko көретін браузерлер мен телефондар. Әрқайсысының өз ойнату баптаулары бар (Баптаулар → Осы құрылғы).",
  "devprefs.this_one": "осы браузер",
  "devprefs.forget": "Ұмыту",
  "devprefs.auto_only": "автоматты түрде",
  "devprefs.ranked_tv": "«{name}» үшін іріктелді",
};

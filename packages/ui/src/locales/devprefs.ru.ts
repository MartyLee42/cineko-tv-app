import type { devprefsEn } from "./devprefs.en";

// ru mirrors devprefs.en.ts key for key.
export const devprefsRu: Record<keyof typeof devprefsEn, string> = {
  "devprefs.this_browser_hint": "Подбор раздач, когда вы смотрите в этом браузере: разрешение, битрейт, кодеки. Автоматические значения — то, что определил сам браузер.",
  "devprefs.sheet_title": "Настройки воспроизведения",
  "devprefs.sheet_subtitle": "{name} · подбор раздач для этого ТВ",
  "devprefs.open": "Настройки воспроизведения",
  "devprefs.suggest_title": "Похоже на слабое устройство — применить пресет?",
  "devprefs.browsers": "Ваши браузеры",
  "devprefs.browsers_hint": "Браузеры и телефоны, где вы смотрите Cineko. У каждого свои настройки воспроизведения (Настройки → Это устройство).",
  "devprefs.this_one": "этот браузер",
  "devprefs.forget": "Забыть",
  "devprefs.auto_only": "автоматически",
  "devprefs.ranked_tv": "Подобрано для «{name}»",
};

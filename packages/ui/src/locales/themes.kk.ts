import type { themesEn } from "./themes.en";

// Тақырып атаулары орысша келеді (TMDB-де қазақшасы жоқ), сондықтан
// септеуге тәуелсіз «Сүйікті тақырыбыңыз: …» түрі қолданылады.
export const themesKk: Record<keyof typeof themesEn, string> = {
  "themes.reason_about": "Сүйікті тақырыбыңыз: {name}",
  "themes.reason": "Сүйікті тақырыбыңыз: {name}",
  "themes.row_about": "Сүйікті тақырыбыңыз: {name}",
  "themes.row": "Сүйікті тақырыбыңыз: {name}",
  "themes.ai_reason": "✦ {text}",
  "themes.taste_title": "Тақырыптар",
  "themes.taste_summary": "Сізге ұнайтын тақырыптар: {list}",
  "themes.taste_hint": "Тақырыптар — сіз бағалаған және соңына дейін көрген фильмдердің TMDB кілт сөздері; ең жиілері аз есептеледі.",
  "themes.taste_hint_untranslated": "Кейбір атаулар TMDB-дегі ағылшынша: оларды күнделікті ЖИ іске қосылуы аударады.",
  "themes.writers": "Сценаристер",
  "themes.cinematographers": "Операторлар",
  "themes.composers": "Композиторлар",
  "themes.admin_themes_ai": "ЖИ тақырыптық айдарлары",
  "themes.admin_themes_ai_hint": "Күніне бір рет DeepSeek әр профильдің көрілмеген жақсы ұсыныстарын тақырыптық айдарларға топтайды (профильге бір қосымша сұрау).",
  "themes.admin_picks_ai": "ЖИ жазған жеке себептер",
  "themes.admin_picks_ai_hint": "Күніне бір рет DeepSeek «Сізге арнап таңдалды» тізімін қайта реттеп, әр фильмге неге сәйкес келетінін бір жолмен жазады (профильге шамамен 1,5 мың токен).",
};

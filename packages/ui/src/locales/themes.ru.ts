import type { themesEn } from "./themes.en";

export const themesRu: Record<keyof typeof themesEn, string> = {
  "themes.reason_about": "Вам нравятся фильмы про {name}",
  "themes.reason": "Ваша тема: {name}",
  "themes.row_about": "Вам нравятся фильмы про {name}",
  "themes.row": "Ваша тема: {name}",
  "themes.ai_reason": "✦ {text}",
  "themes.taste_title": "Темы",
  "themes.taste_summary": "Вам нравятся фильмы про {list}",
  "themes.taste_hint": "Темы — ключевые слова TMDB у фильмов, которые вы оценили и досмотрели; самые частые весят меньше.",
  "themes.taste_hint_untranslated": "Часть названий — английские из TMDB: их переводит ежедневный запуск ИИ.",
  "themes.writers": "Сценаристы",
  "themes.cinematographers": "Операторы",
  "themes.composers": "Композиторы",
  "themes.admin_themes_ai": "Рубрики-темы от ИИ",
  "themes.admin_themes_ai_hint": "Раз в день DeepSeek группирует хорошие непросмотренные рекомендации каждого профиля в тематические рубрики (один дополнительный запрос на профиль).",
  "themes.admin_picks_ai": "Личные причины от ИИ",
  "themes.admin_picks_ai_hint": "Раз в день DeepSeek пересортировывает «Подобрано для вас» и пишет к каждому фильму одну строку — почему он вам подойдёт (около 1,5 тыс. токенов на профиль).",
};

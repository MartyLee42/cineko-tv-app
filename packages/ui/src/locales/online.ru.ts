import type { onlineEn } from "./online.en";

export const onlineRu: Record<keyof typeof onlineEn, string> = {
  // ---- button ----
  "online.watch": "Смотреть онлайн",
  "online.watch_hint": "Без торрента, сразу",
  // ---- picker ----
  "online.picker.title": "Смотреть онлайн",
  "online.picker.loading": "Ищем онлайн-источники…",
  "online.picker.empty": "Онлайн ничего не нашлось",
  "online.picker.voice": "Озвучка",
  "online.picker.quality": "Качество",
  "online.picker.quality_auto": "Авто",
  "online.picker.season": "Сезон {n}",
  "online.picker.episode": "Серия {n}",
  "online.picker.episodes": "Серии",
  "online.picker.play": "Смотреть",
  "online.picker.play_here": "Смотреть здесь",
  "online.picker.play_tv": "На телевизоре",
  "online.picker.preferred": "Ваша озвучка",
  "online.picker.subtitles": "Субтитры",
  "online.picker.failed": "Не удалось запустить",
  "online.picker.close": "Закрыть",
  "online.picker.voices": "Озвучек: {n}",
};

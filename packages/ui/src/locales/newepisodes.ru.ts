// «Новые серии»: русские строки (зеркало newepisodes.en.ts).
import type { newEpisodesEn } from "./newepisodes.en";

export const newEpisodesRu: Record<keyof typeof newEpisodesEn, string> = {
  "newep.title": "Новые серии",
  "newep.short": "Новые",
  "newep.empty": "Новых серий пока нет. Каждую ночь сервер проверяет сериалы, которые вы смотрите и которые в «Моём».",
  "newep.badge_new": "Новая",
  "newep.aired_today": "вышла сегодня",
  "newep.aired_yesterday": "вышла вчера",
  "newep.aired_days.one": "вышла {n} день назад",
  "newep.aired_days.few": "вышла {n} дня назад",
  "newep.aired_days.many": "вышла {n} дней назад",
  "newep.mark_all": "Отметить все просмотренными",
  "newep.watch": "Смотреть",
  "newep.details": "О сериале",
  "newep.mark_watched": "Отметить просмотренной",
  "newep.hide": "Скрыть",
  "newep.hint": "OK — смотреть · удерживайте OK — ещё",
  "newep.earlier": "Просмотренные",
  "newep.from_kinopoisk": "Кинопоиск",
  "newep.count": "{n} новых",
  // ---- admin
  "newep.admin.title": "Проверка новых серий",
  "newep.admin.schedule": "Каждую ночь в {at} ({tz})",
  "newep.admin.off": "Ночная проверка выключена (NEW_EPISODES_AT=off)",
  "newep.admin.next": "Следующая: {at}",
  "newep.admin.run": "Проверить сейчас",
  "newep.admin.running": "Проверяю…",
  "newep.admin.last": "{at} · {trigger} · {status}: сериалов {series}, новых {found}, ошибок обновления {errors}",
  "newep.admin.never": "Проверок ещё не было",
};

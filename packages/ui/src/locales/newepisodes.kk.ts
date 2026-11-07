// "New episodes": Kazakh strings (mirror of newepisodes.en.ts).
import type { newEpisodesEn } from "./newepisodes.en";

export const newEpisodesKk: Record<keyof typeof newEpisodesEn, string> = {
  "newep.title": "Жаңа сериялар",
  "newep.short": "Жаңа",
  "newep.empty": "Әзірге жаңа сериялар жоқ. Сервер әр түн сайын сіз көріп жүрген және «Менікі» бөліміндегі сериалдарды тексереді.",
  "newep.badge_new": "Жаңа",
  "newep.aired_today": "бүгін шықты",
  "newep.aired_yesterday": "кеше шықты",
  "newep.aired_days.one": "{n} күн бұрын шықты",
  "newep.aired_days.few": "{n} күн бұрын шықты",
  "newep.aired_days.many": "{n} күн бұрын шықты",
  "newep.mark_all": "Барлығын көрілді деп белгілеу",
  "newep.watch": "Көру",
  "newep.details": "Сериал туралы",
  "newep.mark_watched": "Көрілді деп белгілеу",
  "newep.hide": "Жасыру",
  "newep.hint": "OK — көру · OK басып тұрыңыз — тағы",
  "newep.earlier": "Көрілгендер",
  "newep.from_kinopoisk": "Кинопоиск",
  "newep.count": "{n} жаңа",
  // ---- admin
  "newep.admin.title": "Жаңа серияларды тексеру",
  "newep.admin.schedule": "Әр түн сайын {at} ({tz})",
  "newep.admin.off": "Түнгі тексеру өшірулі (NEW_EPISODES_AT=off)",
  "newep.admin.next": "Келесісі: {at}",
  "newep.admin.run": "Қазір тексеру",
  "newep.admin.running": "Тексеріп жатырмын…",
  "newep.admin.last": "{at} · {trigger} · {status}: сериалдар {series}, жаңалары {found}, жаңарту қателері {errors}",
  "newep.admin.never": "Әлі тексеру болған жоқ",
};

import type { awardsEn } from "./awards.en";

export const awardsRu: Record<keyof typeof awardsEn, string> = {
  "awards.title": "Награды",
  "awards.wins": "Победы",
  "awards.nominations": "Номинации",
  "awards.nominated": "номинация",
  "awards.more_nominations_one": "ещё {n} номинация ▸",
  "awards.more_nominations_few": "ещё {n} номинации ▸",
  "awards.more_nominations_many": "ещё {n} номинаций ▸",
  "awards.nominations_one": "{n} номинация",
  "awards.nominations_few": "{n} номинации",
  "awards.nominations_many": "{n} номинаций",
  "awards.hide_nominations": "Скрыть номинации ▴",
  "awards.only_nominations": "Только номинации",
  "awards.source": "Источник: Wikidata",
  "awards.badge": "{label} ×{n}",
  "awards.badge_title": "Награды: {label} ×{n}",
  "awards.open": "Награды",
  "awards.group.oscar": "Оскар",
  "awards.group.cannes": "Канны",
  "awards.group.venice": "Венеция",
  "awards.group.berlin": "Берлинале",
};

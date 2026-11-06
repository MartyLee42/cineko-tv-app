import type { superplayEn } from "./superplay.en";

// ru mirrors superplay.en.ts key for key.
export const superplayRu: Record<keyof typeof superplayEn, string> = {
  "superplay.show_all": "Все устройства",
  "superplay.hide_all": "Только мои",
  "superplay.hint": "Супер-админ: ТВ всех пользователей",
  "superplay.none": "Других устройств нет",
} as const;

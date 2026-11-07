import type { superplayEn } from "./superplay.en";

// kk mirrors superplay.en.ts key for key.
export const superplayKk: Record<keyof typeof superplayEn, string> = {
  "superplay.show_all": "Барлық құрылғылар",
  "superplay.hide_all": "Тек менікі",
  "superplay.hint": "Супер-админ: барлық пайдаланушылардың ТВ-лары",
  "superplay.none": "Басқа құрылғылар жоқ",
} as const;

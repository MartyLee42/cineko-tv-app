// «Кто видит чьи лайки» (Админка → Обзор): матрица видимости «Семья советует» (зеркало familyvis.en.ts).
import type { familyVisEn } from "./familyvis.en";

export const familyVisRu: Record<keyof typeof familyVisEn, string> = {
  "familyvis.title": "Кто видит чьи лайки",
  "familyvis.hint":
    "Строки — кто смотрит, столбцы — чьи оценки, избранное и просмотренное он видит в «Семья советует» и на страницах фильмов. Ячейки, которые вы не трогали, следуют настройке профиля «Делиться с семьёй».",
  "familyvis.legend_default": "по умолчанию (настройка профиля)",
  "familyvis.legend_override": "задано администратором",
  "familyvis.legend_shares": "делится",
  "familyvis.legend_private": "не делится",
  "familyvis.corner": "Кто видит ↓ · чьи →",
  "familyvis.all": "все",
  "familyvis.toggle_row": "Переключить всю строку: что видит {name}",
  "familyvis.toggle_col": "Переключить весь столбец: кто видит {name}",
  "familyvis.reset_row": "Вернуть по умолчанию: что видит {name}",
  "familyvis.reset_col": "Вернуть по умолчанию: кто видит {name}",
  "familyvis.reset_all": "Сбросить всё",
  "familyvis.reset_all_confirm": "Вернуть все ячейки к настройкам самих профилей?",
  "familyvis.overrides": "Задано администратором: {n}",
  "familyvis.cell": "{viewer} видит лайки: {sharer}",
  "familyvis.cell_default": "по умолчанию",
  "familyvis.cell_override": "задано администратором",
  "familyvis.self": "Сам себя — не применяется",
  "familyvis.hidden": "скрыл «Семья советует»",
  "familyvis.empty": "Нужно хотя бы два профиля.",
  "familyvis.settings_note": "Администратор может настроить, кто именно их видит.",
};

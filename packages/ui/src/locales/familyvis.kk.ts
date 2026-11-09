// «Кім кімнің лайктарын көреді» (Әкімші → Шолу) — қазақша (familyvis.en.ts айнасы).
import type { familyVisEn } from "./familyvis.en";

export const familyVisKk: Record<keyof typeof familyVisEn, string> = {
  "familyvis.title": "Кім кімнің лайктарын көреді",
  "familyvis.hint":
    "Жолдар — кім көреді, бағандар — кімнің бағаларын, таңдаулыларын және көргендерін «Отбасы ұсынады» бөлімінде және фильм беттерінде көреді. Сіз белгілемеген ұяшықтар профильдің «Отбасымен бөлісу» баптауына сәйкес келеді.",
  "familyvis.legend_default": "әдепкі (профиль баптауы)",
  "familyvis.legend_override": "әкімші орнатқан",
  "familyvis.legend_shares": "бөліседі",
  "familyvis.legend_private": "бөліспейді",
  "familyvis.corner": "Кім көреді ↓ · кімнің →",
  "familyvis.all": "бәрі",
  "familyvis.toggle_row": "Бүкіл жолды ауыстыру: {name} не көреді",
  "familyvis.toggle_col": "Бүкіл бағанды ауыстыру: {name} кімге көрінеді",
  "familyvis.reset_row": "Әдепкіге қайтару: {name} не көреді",
  "familyvis.reset_col": "Әдепкіге қайтару: {name} кімге көрінеді",
  "familyvis.reset_all": "Бәрін қалпына келтіру",
  "familyvis.reset_all_confirm": "Барлық ұяшықты профильдердің өз баптауларына қайтару керек пе?",
  "familyvis.overrides": "Әкімші орнатқан: {n}",
  "familyvis.cell": "{viewer} мына адамның лайктарын көреді: {sharer}",
  "familyvis.cell_default": "әдепкі",
  "familyvis.cell_override": "әкімші орнатқан",
  "familyvis.self": "Өзі — қолданылмайды",
  "familyvis.hidden": "«Отбасы ұсынады» бөлімін жасырған",
  "familyvis.empty": "Кемінде екі профиль қажет.",
  "familyvis.settings_note": "Оларды нақты кім көретінін әкімші баптай алады.",
};

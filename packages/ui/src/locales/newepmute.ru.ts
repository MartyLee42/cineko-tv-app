// «Новые серии»: не уведомлять о сериале (зеркало newepmute.en.ts).
import type { newEpMuteEn } from "./newepmute.en";

export const newEpMuteRu: Record<keyof typeof newEpMuteEn, string> = {
  "newepmute.mute": "Не уведомлять о сериале",
  "newepmute.muted": "Больше не сообщаем о новых сериях «{title}»",
  "newepmute.undo": "Отменить",
  "newepmute.hidden": "Скрытые сериалы ({n})",
  "newepmute.unmute": "Уведомлять снова",
  "newepmute.toggle": "Новые серии",
  "newepmute.toggle_on": "Сообщаем о новых сериях — нажмите, чтобы не уведомлять",
  "newepmute.toggle_off": "О новых сериях не сообщаем — нажмите, чтобы уведомлять снова",
};

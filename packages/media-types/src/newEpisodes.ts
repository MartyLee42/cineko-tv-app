// «Новые серии» (nightly new-episode check): pure helpers shared by the TV
// app and the PWA.

/** Whole days between an air date ("YYYY-MM-DD") and `now` in local time (0 = today; null when unknown). */
export function daysSinceAir(airDate: string | null | undefined, now: Date = new Date()): number | null {
  if (!airDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(airDate);
  if (!m) return null;
  const aired = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today - aired) / 86_400_000));
}

/** i18n key + count for «вышла N дн. назад» (plural forms: newep.aired_days.one|few|many). */
export function airedKey(days: number | null): { key: "newep.aired_today" | "newep.aired_yesterday" | "newep.aired_days"; n: number } | null {
  if (days === null) return null;
  if (days === 0) return { key: "newep.aired_today", n: 0 };
  if (days === 1) return { key: "newep.aired_yesterday", n: 1 };
  return { key: "newep.aired_days", n: days };
}

/** Russian plural form index: 0 one, 1 few, 2 many. */
export function pluralFormRu(n: number): 0 | 1 | 2 {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return 2;
  if (b === 1) return 0;
  if (b >= 2 && b <= 4) return 1;
  return 2;
}

/**
 * The list without one series' items (optimistic «Не уведомлять о сериале»):
 * the unseen count drops by that series' unseen items (never below 0).
 */
export function withoutSeries<T extends { media: { id: string }; seen: boolean }, L extends { items: T[]; unseen: number }>(list: L, mediaId: string): L {
  const gone = list.items.filter((it) => it.media.id === mediaId);
  if (gone.length === 0) return list;
  const unseen = gone.filter((it) => !it.seen).length;
  return { ...list, items: list.items.filter((it) => it.media.id !== mediaId), unseen: Math.max(0, list.unseen - unseen) };
}

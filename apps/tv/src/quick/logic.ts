// The TV quick-actions popup (hold OK / ☰ / Info on a poster card): which
// lines it shows and the remote keys that open it. Pure.

export type QuickLine = "like" | "want" | "rate" | "dismiss" | "open";

/** Lines top to bottom: ♥, «Буду смотреть», the rating, then «Не интересно» / «Подробнее» when offered. */
export function quickLines(o: { dismiss: boolean; open: boolean }): QuickLine[] {
  const out: QuickLine[] = ["like", "want", "rate"];
  if (o.dismiss) out.push("dismiss");
  if (o.open) out.push("open");
  return out;
}

/** ▲ / ▼ in the popup (stops at the ends). */
export function moveLine(index: number, delta: number, count: number): number {
  return Math.max(0, Math.min(count - 1, index + delta));
}

type KeyLike = Pick<KeyboardEvent, "key" | "keyCode">;

/** ☰ / Tools / ContextMenu / Info: open the focused card's quick actions (as holding OK does). */
export function isQuickKey(e: KeyLike): boolean {
  return e.key === "ContextMenu" || e.key === "Info" || e.keyCode === 93 || e.keyCode === 10135 || e.keyCode === 457;
}

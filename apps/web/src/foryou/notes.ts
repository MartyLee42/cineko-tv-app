// Personal notes on titles («Моя заметка», «Почему?»): pure helpers.
import type { Schemas } from "@martytv/contracts";
import type { MessageKey } from "@martytv/ui";

export type NoteReason = Schemas["NoteReason"];
export type MediaNote = Schemas["MediaNote"];

export const DISLIKE_REASONS: NoteReason[] = ["too_slow", "too_scary", "too_violent", "boring_plot", "bad_acting", "not_my_genre", "already_seen", "bad_ending", "too_long", "childish"];
export const LIKE_REASONS: NoteReason[] = ["loved_atmosphere", "great_acting", "smart_plot", "funny", "beautiful"];
export const NOTE_MAX = 1000;

export type ReasonSide = "dislike" | "like" | "all";

/** Which chips to suggest for a rating: ≤ 5 dislike, ≥ 8 like, else both. */
export function sideForRating(rating: number | null | undefined): ReasonSide {
  if (rating == null) return "all";
  if (rating <= 5) return "dislike";
  if (rating >= 8) return "like";
  return "all";
}

/** Chips for a side; chips already on the note always stay visible. */
export function reasonChips(side: ReasonSide, selected: readonly NoteReason[] = []): NoteReason[] {
  const base = side === "dislike" ? DISLIKE_REASONS : side === "like" ? LIKE_REASONS : [...DISLIKE_REASONS, ...LIKE_REASONS];
  return [...base, ...selected.filter((r) => !base.includes(r))];
}

export function toggleReason(list: readonly NoteReason[], r: NoteReason): NoteReason[] {
  return list.includes(r) ? list.filter((x) => x !== r) : [...list, r];
}

export const reasonKey = (r: NoteReason) => `taste.reason.${r}` as MessageKey;

/** The PUT body: trimmed text, unique reasons. Empty → the note is deleted. */
export function noteBody(text: string, reasons: readonly NoteReason[]): { text: string; reasons: NoteReason[] } {
  return { text: text.trim(), reasons: [...new Set(reasons)] };
}

export function noteEmpty(n: { text: string; reasons: readonly unknown[] } | null | undefined): boolean {
  return !n || (n.text.trim() === "" && n.reasons.length === 0);
}

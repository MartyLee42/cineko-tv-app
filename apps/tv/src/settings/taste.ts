// Recommendation preferences on the TV: the taste note («О моих вкусах»,
// typed with the on-screen keyboard) and min_votes («Минимум оценок»).
import type { KeyAction } from "../catalog/keyboard";

export const TASTE_NOTE_MAX = 600;
export const MIN_VOTES_CHOICES = [0, 50, 100, 300, 1000, 5000] as const;
export type MinVotes = (typeof MIN_VOTES_CHOICES)[number];
export const DEFAULT_MIN_VOTES: MinVotes = 100;

export function parseMinVotes(v: unknown): MinVotes {
  return (MIN_VOTES_CHOICES as readonly unknown[]).includes(v) ? (v as MinVotes) : DEFAULT_MIN_VOTES;
}

/** One line for the settings row: whitespace collapsed, "…" past max chars. */
export function truncateNote(note: string, max = 60): string {
  const one = note.trim().replace(/\s+/g, " ");
  const chars = [...one];
  return chars.length <= max ? one : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/**
 * Applies a key to the note. The keyboard only has capitals: letters are
 * typed lower-case, capitalized at the start and after ". ", "! ", "? ".
 * raw = a physical keyboard: the character is kept as typed.
 */
export function applyNoteKey(text: string, a: KeyAction, raw = false, max = TASTE_NOTE_MAX): string {
  switch (a.type) {
    case "char": {
      const sentence = text.trim() === "" || /[.!?]\s$/.test(text);
      const ch = raw ? a.value : sentence ? a.value.toUpperCase() : a.value.toLowerCase();
      return [...(text + ch)].length > max ? text : text + ch;
    }
    case "space":
      return text === "" || text.endsWith(" ") || [...text].length >= max ? text : text + " ";
    case "backspace":
      return [...text].slice(0, -1).join("");
    case "clear":
      return "";
  }
}

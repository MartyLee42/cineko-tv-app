// Taste quiz («Давайте определим ваш вкус»): remote navigation and answer
// helpers, pure (unit-tested). The screen is TasteQuiz.tsx.
import type { MessageKey } from "@martytv/ui";

export type QuizAnswers = Record<string, string[]>;

export interface QuizQuestion {
  id: string;
  multi: boolean;
  options: string[];
}

export type Dir = "left" | "right" | "up" | "down";

/** Stars on the title card (the 1–10 rating). */
export const STARS = 10;
/** Buttons under the stars: what else one can say about a title. */
export const TITLE_ACTIONS = ["unseen", "want", "not_interested", "enough"] as const;
export type TitleAction = (typeof TITLE_ACTIONS)[number];

/** Option chips per row on the question screen. */
export const COLS = 4;

/**
 * Moves through `count` chips laid out `cols` per row, then a row of
 * `buttons` buttons (indices count…count+buttons-1).
 */
export function gridMove(i: number, count: number, cols: number, buttons: number, dir: Dir): number {
  const inButtons = i >= count;
  if (inButtons) {
    if (dir === "left") return Math.max(count, i - 1);
    if (dir === "right") return Math.min(count + buttons - 1, i + 1);
    if (dir === "up") return count > 0 ? Math.floor((count - 1) / cols) * cols : i;
    return i;
  }
  const col = i % cols;
  if (dir === "left") return col > 0 ? i - 1 : i;
  if (dir === "right") return col < cols - 1 && i + 1 < count ? i + 1 : i;
  if (dir === "up") return i - cols >= 0 ? i - cols : i;
  // down: the next row, else (from the last row) the buttons.
  if (i + cols < count) return i + cols;
  if (Math.floor(i / cols) < Math.floor((count - 1) / cols)) return count - 1;
  return buttons > 0 ? count + Math.min(buttons - 1, 2) : i;
}

/** Selecting an option: multi toggles; single replaces (or clears). */
export function toggleOption(sel: readonly string[], opt: string, multi: boolean): string[] {
  if (sel.includes(opt)) return sel.filter((o) => o !== opt);
  return multi ? [...sel, opt] : [opt];
}

/** Label key of an option (genre questions share the genre names). */
export function optionKey(question: string, opt: string): MessageKey {
  return (question.startsWith("genres_") ? `quiz.g.${opt}` : `quiz.o.${question}.${opt}`) as MessageKey;
}

/** Same selection (order-insensitive). */
export function sameSelection(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = [...(a ?? [])].sort();
  const y = [...(b ?? [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Mood chips get a little picture. */
export const MOOD_EMOJI: Record<string, string> = {
  light: "☀️",
  funny: "😂",
  tense: "😬",
  dark: "🌑",
  tearjerker: "😢",
  thoughtful: "🤔",
  epic: "⚔️",
};

/** Whether the Home invitation may show: never finished or dismissed, not «later» this session. */
export function inviteDue(state: { completed_at: string | null; dismissed_at: string | null } | undefined, laterThisSession: boolean): boolean {
  return !!state && !state.completed_at && !state.dismissed_at && !laterThisSession;
}

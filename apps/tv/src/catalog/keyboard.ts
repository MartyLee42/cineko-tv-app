// On-screen keyboard layouts and text editing for TV search.

export type Layout = "en" | "ru";

const DIGITS = "1234567890".split("");

export const LAYOUTS: Record<Layout, string[]> = {
  en: [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""), ...DIGITS],
  ru: [..."АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ".split(""), ...DIGITS],
};

/** Keys per keyboard row. */
export const KEYBOARD_COLS = 7;

export const MAX_QUERY = 100;

export type KeyAction =
  | { type: "char"; value: string }
  | { type: "space" }
  | { type: "backspace" }
  | { type: "clear" };

/** Applies one key to the query text. */
export function applyKey(text: string, action: KeyAction): string {
  switch (action.type) {
    case "char":
      return (text + action.value).slice(0, MAX_QUERY);
    case "space":
      // No leading or double spaces: they would only change the debounce key.
      return text === "" || text.endsWith(" ") ? text : (text + " ").slice(0, MAX_QUERY);
    case "backspace":
      return text.slice(0, -1);
    case "clear":
      return "";
  }
}

/**
 * Maps a physical keyboard event key to an action, or null for keys the
 * search box ignores (arrows, Enter, modifiers…). Works for any script,
 * so a Russian hardware layout types Cyrillic directly.
 */
export function physicalKey(key: string, modifiers = false): KeyAction | null {
  if (modifiers) return null;
  if (key === "Backspace") return { type: "backspace" };
  if (key === " " || key === "Spacebar") return { type: "space" };
  if (key.length === 1 && /\S/.test(key)) return { type: "char", value: key.toUpperCase() };
  return null;
}

/** Text sent to the API: trimmed, single spaces. */
export function normalizeQuery(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function otherLayout(l: Layout): Layout {
  return l === "en" ? "ru" : "en";
}

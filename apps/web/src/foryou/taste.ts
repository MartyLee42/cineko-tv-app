// Recommendation preferences (profile settings taste_note / min_votes):
// pure helpers for the Settings «О моих вкусах» card and the min_votes select.
import type { ProfileSettings } from "@martytv/contracts";

export type MinVotes = ProfileSettings["min_votes"];

export const TASTE_NOTE_MAX = 600;
export const MIN_VOTES_CHOICES: MinVotes[] = [0, 50, 100, 300, 1000, 5000];
export const DEFAULT_MIN_VOTES: MinVotes = 100;

/** The note as the server stores it: trimmed. */
export function normalizeNote(s: string): string {
  return s.trim();
}

/** Characters the server counts (code points of the trimmed note). */
export function noteLength(s: string): number {
  return [...normalizeNote(s)].length;
}

export function noteTooLong(s: string): boolean {
  return noteLength(s) > TASTE_NOTE_MAX;
}

/** Whether the draft differs from the saved note (ignoring outer spaces). */
export function noteDirty(saved: string | undefined, draft: string): boolean {
  return normalizeNote(saved ?? "") !== normalizeNote(draft);
}

export function parseMinVotes(v: string | number): MinVotes {
  const n = Number(v);
  return (MIN_VOTES_CHOICES as number[]).includes(n) ? (n as MinVotes) : DEFAULT_MIN_VOTES;
}

// ---- DeepSeek balance (admin «Рекомендации») ----

export interface AIBalance {
  available: boolean;
  currency: string;
  total: number;
}

/** Warning when DeepSeek reports it can't serve calls or less than 1 unit is left. */
export function balanceLow(b: AIBalance): boolean {
  return !b.available || b.total < 1;
}

export function formatBalance(b: AIBalance, locale: string): string {
  try {
    return new Intl.NumberFormat(locale === "en" ? "en-US" : locale === "kk" ? "kk-KZ" : "ru-RU", { style: "currency", currency: b.currency || "USD" }).format(b.total);
  } catch {
    return `${b.total.toFixed(2)} ${b.currency}`;
  }
}

// ---- «Обновить подборки ИИ» ----

export interface RegenLike {
  available: boolean;
  running: boolean;
  unlimited: boolean;
  ai_enabled: boolean;
  next_available_at: string;
}

export type RegenState = "hidden" | "available" | "running" | "used";

/** What the regenerate button shows (hidden without AI). */
export function regenState(s: RegenLike | undefined): RegenState {
  if (!s || !s.ai_enabled) return "hidden";
  if (s.running) return "running";
  return s.available ? "available" : "used";
}

/** "00:00"-style time of the next regeneration, in the viewer's time zone. */
export function regenTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleTimeString(locale === "en" ? "en-GB" : locale === "kk" ? "kk-KZ" : "ru-RU", { hour: "2-digit", minute: "2-digit" });
}

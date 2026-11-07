// The watch companion on Details («Ранее в сериале», «После титров»):
// pure helpers both clients share. Shapes mirror the contract's
// MediaCompanion / AfterCreditsChat (structural, like trivia.ts).
import type { MessageKey } from "./i18n";

export type CompanionTopic = "ending" | "significance";
export type AfterTab = CompanionTopic | "chat";
export const AFTER_TABS: AfterTab[] = ["ending", "significance", "chat"];

/** Chat message length the API accepts. */
export const CHAT_MIN = 2;
export const CHAT_MAX = 300;

/** Query-cache lifetime of the availability (it changes as you watch). */
export const COMPANION_STALE_MS = 5 * 60_000;

export interface CompanionStatusLike {
  ai_enabled: boolean;
  recap: { available: boolean };
  after_credits: { available: boolean; scope: string; season: number | null };
}

/** «Ранее в сериале»: AI on, a series resting ≥ 7 days with episodes finished. */
export function showRecapButton(s: CompanionStatusLike | undefined): boolean {
  return !!s?.ai_enabled && s.recap.available;
}

/** «После титров»: AI on and the title (or a season) finished. */
export function showAfterButton(s: CompanionStatusLike | undefined): boolean {
  return !!s?.ai_enabled && s.after_credits.available;
}

/** The scope line: what the spoilers cover. */
export function afterScopeLabel(scope: string, season: number | null): { key: MessageKey; vars?: Record<string, number> } {
  if (scope === "season" && season) return { key: "companion.scope.season", vars: { n: season } };
  if (scope === "series") return { key: "companion.scope.series" };
  return { key: "companion.scope.movie" };
}

/** API error code → message (unknown codes: the generic failure). */
export function companionErrorKey(code: string | undefined): MessageKey {
  switch (code) {
    case "companion_limit":
      return "companion.error.limit";
    case "ai_budget":
      return "companion.error.budget";
    case "no_synopses":
      return "companion.error.no_synopses";
    case "not_eligible":
      return "companion.error.not_eligible";
    case "ai_disabled":
      return "companion.error.disabled";
    case "chat_full":
      return "companion.error.chat_full";
  }
  return "companion.error.failed";
}

/** Errors worth a retry button (the AI hiccuped, the network dropped). */
export function companionRetryable(code: string | undefined): boolean {
  return companionErrorKey(code) === "companion.error.failed";
}

/** The chat input: trimmed, single-spaced, within limits, questions left. */
export function chatCanSend(text: string, remaining: number): boolean {
  const n = [...text.trim().replace(/\s+/g, " ")].length;
  return remaining > 0 && n >= CHAT_MIN && n <= CHAT_MAX;
}

/** Next/previous tab with ◀ ▶ (clamped). */
export function stepTab(tab: AfterTab, delta: number): AfterTab {
  const i = AFTER_TABS.indexOf(tab) + delta;
  return AFTER_TABS[Math.max(0, Math.min(AFTER_TABS.length - 1, i))]!;
}

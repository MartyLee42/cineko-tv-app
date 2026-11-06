// Pure helpers for «Спросить ИИ» (/ask): request building, error → message
// mapping, the phone → TV URL params and the example chips.
import type { MessageKey } from "@martytv/ui";

export type AskKind = "any" | "movie" | "series";

export interface AskForm {
  prompt: string;
  kind: AskKind;
  includeWatched: boolean;
}

export const ASK_MIN = 3;
export const ASK_MAX = 500;

/** Example chips: label key + the prompt it sends. */
export const ASK_EXAMPLES = ["light", "interstellar", "weekend", "family"] as const;
export type AskExample = (typeof ASK_EXAMPLES)[number];
export const exampleLabel = (e: AskExample) => `ask.example.${e}` as MessageKey;
export const examplePrompt = (e: AskExample) => `ask.example.${e}.prompt` as MessageKey;

/** Trimmed, whitespace-collapsed prompt; null when too short. Long input is cut to ASK_MAX. */
export function cleanPrompt(s: string): string | null {
  const p = s.replace(/\s+/g, " ").trim();
  if ([...p].length < ASK_MIN) return null;
  return [...p].slice(0, ASK_MAX).join("");
}

export interface AskBody {
  profile_id: string;
  prompt: string;
  lang: "en" | "ru";
  kind: AskKind;
  include_watched: boolean;
  device_id?: string;
}

export function askBody(form: AskForm, profileId: string, lang: "en" | "ru", deviceId?: string | null): AskBody | null {
  const prompt = cleanPrompt(form.prompt);
  if (!prompt) return null;
  return { profile_id: profileId, prompt, lang, kind: form.kind, include_watched: form.includeWatched, ...(deviceId ? { device_id: deviceId } : {}) };
}

export type AskErrorKind = "disabled" | "limit" | "budget" | "failed" | "generic";

/** Maps an API error (status + code) to the page's error state. */
export function askErrorKind(err: unknown): AskErrorKind {
  const e = err as { status?: number; code?: string } | null;
  switch (e?.code) {
    case "ai_disabled":
      return "disabled";
    case "ask_limit":
      return "limit";
    case "ai_budget":
      return "budget";
    case "ai_failed":
      return "failed";
  }
  if (e?.status === 503) return "disabled";
  if (e?.status === 429) return "limit";
  if (e?.status === 502 || e?.status === 504) return "failed";
  return "generic";
}

export const ASK_ERROR: Record<AskErrorKind, { title?: MessageKey; text: MessageKey; retry: boolean }> = {
  disabled: { title: "ask.err.disabled_title", text: "ask.err.disabled", retry: false },
  limit: { title: "ask.err.limit_title", text: "ask.err.limit", retry: false },
  budget: { title: "ask.err.limit_title", text: "ask.err.budget", retry: false },
  failed: { text: "ask.err.failed", retry: true },
  generic: { text: "ask.err.generic", retry: true },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/ask?device=<tv id>&profile=<profile id>` (the TV's QR): the TV to send the
 * answer to, and the profile to ask as when it is one of the account's.
 */
export function askTarget(search: string, profileIds: readonly string[]): { deviceId: string | null; profileId: string | null } {
  const q = new URLSearchParams(search);
  const d = q.get("device") ?? "";
  const p = q.get("profile") ?? "";
  return { deviceId: UUID.test(d) ? d.toLowerCase() : null, profileId: profileIds.includes(p) ? p : null };
}

/** A follow-up chip pre-fills the input: the chip text alone when the box is empty or holds the last prompt, else appended. */
export function withFollowup(current: string, lastPrompt: string, followup: string): string {
  const c = current.trim();
  if (!c || c === lastPrompt.trim()) return followup;
  if (c.toLowerCase().includes(followup.toLowerCase())) return c;
  return `${c.replace(/[.,;!?\s]+$/, "")}, ${followup.charAt(0).toLowerCase()}${followup.slice(1)}`;
}

/** Short relative-ish date for the history list. */
export function askWhen(iso: string, now: Date, locale: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(locale, { day: "numeric", month: "short" });
}

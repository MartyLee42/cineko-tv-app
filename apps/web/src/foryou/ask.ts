// Pure helpers for «Спросить ИИ» in the PWA (/ask and the search's «✦ ИИ»):
// request building, the phone → TV URL params and the example chips. The
// core shared with the TV (prompt bounds, refinement, errors) is in
// @martytv/ui (aiAsk.ts).
import { ASK_INCLUDE_WATCHED_DEFAULT, cleanPrompt, type AskKind, type MessageKey } from "@martytv/ui";

export { ASK_ERROR, ASK_INCLUDE_WATCHED_DEFAULT, ASK_MAX, ASK_MIN, askErrorKind, cleanPrompt, refinePrompt } from "@martytv/ui";
export type { AskErrorKind, AskKind } from "@martytv/ui";

export interface AskForm {
  prompt: string;
  kind: AskKind;
  includeWatched: boolean;
}

/** Example chips: label key + the prompt it sends. */
export const ASK_EXAMPLES = ["light", "interstellar", "weekend", "family"] as const;
export type AskExample = (typeof ASK_EXAMPLES)[number];
export const exampleLabel = (e: AskExample) => `ask.example.${e}` as MessageKey;
export const examplePrompt = (e: AskExample) => `ask.example.${e}.prompt` as MessageKey;

export interface AskBody {
  profile_id: string;
  prompt: string;
  lang: "en" | "ru";
  kind: AskKind;
  include_watched: boolean;
  device_id?: string;
}

/** A fresh form: no prompt, everything, watched titles left out. */
export const newAskForm = (): AskForm => ({ prompt: "", kind: "any", includeWatched: ASK_INCLUDE_WATCHED_DEFAULT });

export function askBody(form: AskForm, profileId: string, lang: "en" | "ru", deviceId?: string | null): AskBody | null {
  const prompt = cleanPrompt(form.prompt);
  if (!prompt) return null;
  return { profile_id: profileId, prompt, lang, kind: form.kind, include_watched: form.includeWatched, ...(deviceId ? { device_id: deviceId } : {}) };
}

/** The form a past ask was sent with (refining or retrying it keeps kind and watched). */
export function formOf(a: { prompt: string; kind: string; include_watched: boolean }): AskForm {
  const kind: AskKind = a.kind === "movie" || a.kind === "series" ? a.kind : "any";
  return { prompt: a.prompt, kind, includeWatched: a.include_watched };
}

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

/** Short relative-ish date for the history list. */
export function askWhen(iso: string, now: Date, locale: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(locale, { day: "numeric", month: "short" });
}

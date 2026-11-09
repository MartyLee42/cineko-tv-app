// The shared core of «Спросить ИИ» (POST /foryou/ask) for every entry point:
// the PWA's /ask page, the search page's «✦ ИИ» mode and the TV's Ask
// screen. Prompt bounds, refinement (follow-up chips), defaults and the
// error → message mapping live here so all three ask and answer alike.
import type { MessageKey } from "./i18n";

export type AskKind = "any" | "movie" | "series";

export const ASK_MIN = 3;
export const ASK_MAX = 500;

/** Watched titles are left out unless the viewer ticks «Включая просмотренное». */
export const ASK_INCLUDE_WATCHED_DEFAULT = false;

/** Trimmed, whitespace-collapsed prompt; null when too short. Long input is cut to ASK_MAX. */
export function cleanPrompt(s: string): string | null {
  const p = s.replace(/\s+/g, " ").trim();
  if ([...p].length < ASK_MIN) return null;
  return [...p].slice(0, ASK_MAX).join("");
}

/**
 * A follow-up chip («Покороче», «А из 90-х?») refines the previous ask: the
 * server keeps no conversation, so the chip is appended to the previous
 * prompt to keep its constraints. A chip already in the prompt changes
 * nothing; when the result is too long the oldest words go, the chip stays.
 */
export function refinePrompt(previous: string, followup: string): string {
  const prev = previous.replace(/\s+/g, " ").trim();
  const f = followup.replace(/\s+/g, " ").trim();
  if (!f) return prev;
  if (!prev) return f;
  if (prev.toLowerCase().includes(f.toLowerCase())) return prev;
  const tail = `, ${f.charAt(0).toLowerCase()}${f.slice(1)}`;
  const head = prev.replace(/[.,;!?\s]+$/, "");
  const room = ASK_MAX - [...tail].length;
  if (room < ASK_MIN) return [...f].slice(0, ASK_MAX).join("");
  const chars = [...head];
  if (chars.length <= room) return head + tail;
  // Drop from the start, at a word boundary.
  const cut = chars.slice(chars.length - room).join("");
  const sp = cut.indexOf(" ");
  return `${(sp >= 0 && sp < cut.length - 1 ? cut.slice(sp + 1) : cut).replace(/^[.,;!?\s]+/, "")}${tail}`;
}

export type AskErrorKind = "disabled" | "limit" | "budget" | "failed" | "generic";

/** Maps an API error (ApiError or any {status, code}) to the error state. */
export function askErrorKind(err: unknown): AskErrorKind {
  const e = err as { status?: unknown; code?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  const status = typeof e?.status === "number" ? e.status : 0;
  switch (code) {
    case "ai_disabled":
      return "disabled";
    case "ask_limit":
      return "limit";
    case "ai_budget":
      return "budget";
    case "ai_failed":
      return "failed";
  }
  if (status === 503) return "disabled";
  if (status === 429) return "limit";
  if (status === 502 || status === 504) return "failed";
  return "generic";
}

export const ASK_ERROR: Record<AskErrorKind, { title?: MessageKey; text: MessageKey; retry: boolean }> = {
  disabled: { title: "ask.err.disabled_title", text: "ask.err.disabled", retry: false },
  limit: { title: "ask.err.limit_title", text: "ask.err.limit", retry: false },
  budget: { title: "ask.err.limit_title", text: "ask.err.budget", retry: false },
  failed: { text: "ask.err.failed", retry: true },
  generic: { text: "ask.err.generic", retry: true },
};

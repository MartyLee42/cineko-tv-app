// «Цитаты» / «Факты» on the details page (GET /media/{id}/quotes, /facts):
// response types and the pure helpers both clients share.
//
// The types mirror the contract's MediaQuotes / MediaFacts (@martytv/ui doesn't
// depend on @martytv/contracts); the apps' query hooks return the generated
// types through these, so tsc flags any drift.

export type TriviaLang = "ru" | "en";

export interface MediaQuote {
  text: string;
  speaker: string | null;
}

export interface MediaQuotes {
  /** ≤ 12; empty = none found. */
  items: MediaQuote[];
  source: "wikiquote" | null;
  /** The Wikiquote page. */
  source_url: string | null;
  /** Language of the quotes (falls back ru↔en, so may differ from ?lang). */
  lang: TriviaLang;
}

export interface MediaFact {
  text: string;
  kind: "fact" | "blooper";
  spoiler: boolean;
}

export interface MediaFacts {
  /** ≤ 15; plain text. */
  items: MediaFact[];
  /** "ai" = written by the AI because Kinopoisk had none. */
  source: "kinopoisk" | "ai" | null;
  source_url: string | null;
  lang: TriviaLang;
}

/** Query-cache lifetime: quotes and facts of a title practically never change. */
export const TRIVIA_STALE_MS = 24 * 3600_000;

const OPEN = "«\"“„‘'‹「";
const CLOSE = "»\"”“’'›」";

/** The quote's text without the quotation marks it may already carry. */
export function stripQuoteMarks(text: string): string {
  let s = text.trim();
  while (s.length >= 2 && OPEN.includes(s[0]!) && CLOSE.includes(s[s.length - 1]!)) s = s.slice(1, -1).trim();
  return s;
}

/** The quote in the language's marks: «ёлочки» for Russian, “curly” for English. */
export function formatQuote(text: string, lang: string): string {
  const s = stripQuoteMarks(text);
  return lang === "ru" ? `«${s}»` : `“${s}”`;
}

/** «— Speaker» under a quote (null without a speaker). */
export function formatSpeaker(speaker: string | null | undefined): string | null {
  const s = speaker?.trim().replace(/^[—–-]\s*/, "");
  return s ? `— ${s}` : null;
}

/** The «Цитаты» button: shown while loading or on error (opens a retry), hidden once known empty. */
export function showQuotesButton(q: { isPending: boolean; isError: boolean; data?: MediaQuotes }): boolean {
  if (q.isError) return true;
  if (q.isPending || !q.data) return true;
  return q.data.items.length > 0;
}

/** Index after a ←/→ (or ↑/↓) step: clamps, or wraps around with `wrap`. */
export function stepIndex(i: number, delta: number, n: number, wrap = false): number {
  if (n <= 0) return 0;
  const j = i + delta;
  if (wrap) return ((j % n) + n) % n;
  return Math.max(0, Math.min(n - 1, j));
}

/** Spoiler facts start hidden; revealing one keeps the others hidden. */
export function isFactHidden(f: MediaFact, i: number, revealed: ReadonlySet<number>): boolean {
  return f.spoiler && !revealed.has(i);
}

export function revealFact(revealed: ReadonlySet<number>, i: number): Set<number> {
  const next = new Set(revealed);
  next.add(i);
  return next;
}

/** Locale key of the facts' source line (null: no source to name). */
export function factsSourceKey(source: MediaFacts["source"]): "trivia.source.kinopoisk" | "trivia.source.ai" | null {
  return source === "kinopoisk" ? "trivia.source.kinopoisk" : source === "ai" ? "trivia.source.ai" : null;
}

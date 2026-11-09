// «Спросить ИИ» on the TV (pure, unit-tested in ask.test.ts): examples, the
// phone link and the inbox for answers asked from a phone (realtime
// `foryou.ask`). Queries live in ask.ts. The core shared with the PWA's /ask
// and search (prompt bounds, refinement, errors) is in @martytv/ui (aiAsk.ts).
import type { Schemas } from "@martytv/contracts";
import { ASK_ERROR, cleanPrompt, type MessageKey } from "@martytv/ui";

export { askErrorKind, refinePrompt } from "@martytv/ui";
export type { AskErrorKind, AskKind } from "@martytv/ui";

export type AskResult = Schemas["ForYouAsk"];

/** Big example tiles: label key + the prompt sent at once. */
export const ASK_EXAMPLES = [
  { id: "light", emoji: "🍿" },
  { id: "interstellar", emoji: "🚀" },
  { id: "weekend", emoji: "📺" },
  { id: "family", emoji: "🏡" },
  { id: "heist", emoji: "💰" },
  { id: "cozy", emoji: "☕" },
] as const;
export type AskExample = (typeof ASK_EXAMPLES)[number];

export const exampleLabel = (e: AskExample) => `ask.example.${e.id}` as MessageKey;
export const examplePrompt = (e: AskExample) => `ask.example.${e.id}.prompt` as MessageKey;

/** The phone page that asks on behalf of this TV (answers arrive as `foryou.ask`). */
export function phoneAskUrl(origin: string, deviceId: string, profileId: string | null): string {
  const q = `device=${encodeURIComponent(deviceId)}${profileId ? `&profile=${encodeURIComponent(profileId)}` : ""}`;
  return `${origin.replace(/\/+$/, "")}/ask?${q}`;
}

/** Shown without the scheme next to the QR (shorter to read). */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\?.*$/, "");
}

/** API error → what the screen says (and whether retrying makes sense). */
export const askErrorText = ASK_ERROR;

/** Long text fitted to the input line: the tail stays visible while typing. */
export function tailText(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
}

/** The on-screen keyboard types capitals: sent (and shown) as a sentence. */
export function sentenceCase(text: string): string {
  const s = text.toLowerCase().replace(/\s+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Long enough to ask (longer text is cut to the limit, as on the phone). */
export function askValid(text: string): boolean {
  return cleanPrompt(text) !== null;
}

// ---------------------------------------------------------------- phone inbox

type Listener = (r: AskResult) => void;
let pending: AskResult | null = null;
const listeners = new Set<Listener>();

/** Answers asked from a phone: delivered to the mounted screen, else kept for the next one. */
export const askInbox = {
  push(r: AskResult) {
    if (listeners.size === 0) pending = r;
    else listeners.forEach((l) => l(r));
  },
  take(): AskResult | null {
    const r = pending;
    pending = null;
    return r;
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};

/** Validates a realtime `foryou.ask` payload. */
export function parseAskEvent(payload: unknown): AskResult | null {
  const p = payload as Partial<AskResult> | null | undefined;
  if (!p || typeof p !== "object" || typeof p.answer !== "string" || !Array.isArray(p.items) || typeof p.prompt !== "string") return null;
  return { followups: [], refused: false, tokens: 0, ...p } as AskResult;
}


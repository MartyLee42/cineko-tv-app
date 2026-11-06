// Pure helpers for recommendations between people («Посоветовать»).
import type { Recommendation } from "@martytv/contracts";

export type Reaction = "like" | "dislike" | "watched";
export const REACTIONS: Reaction[] = ["like", "dislike", "watched"];
export const REACTION_EMOJI: Record<Reaction, string> = { like: "👍", dislike: "👎", watched: "✓" };

export type Inbox = { items: Recommendation[]; unseen: number };
export type RecoPatch = { seen?: boolean; reaction?: Reaction | null };

/** "Bob", "Bob and Carol", "Bob, Carol and Dave" in the UI language. */
export function joinNames(names: string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

export function countUnseen(items: Recommendation[]): number {
  return items.filter((r) => !r.seen_at).length;
}

/** Optimistic PATCH: reacting implies seen (like the server). */
export function applyPatch(inbox: Inbox, id: string, patch: RecoPatch, now = new Date().toISOString()): Inbox {
  const items = inbox.items.map((r) => {
    if (r.id !== id) return r;
    const next = { ...r };
    if (patch.reaction !== undefined) next.reaction = patch.reaction;
    if (patch.seen === false) next.seen_at = null;
    else if (patch.seen || patch.reaction !== undefined) next.seen_at = r.seen_at ?? now;
    return next;
  });
  return { items, unseen: countUnseen(items) };
}

export function removeFromInbox(inbox: Inbox, id: string): Inbox {
  const items = inbox.items.filter((r) => r.id !== id);
  return { items, unseen: countUnseen(items) };
}

/** Clicking the active reaction again clears it. */
export function nextReaction(current: string | null | undefined, clicked: Reaction): Reaction | null {
  return current === clicked ? null : clicked;
}

/** Home row: unseen first, then newest; one card per title (newest wins). */
export function rowItems(items: Recommendation[], max = 20): Recommendation[] {
  const seen = new Set<string>();
  const out: Recommendation[] = [];
  const sorted = [...items].sort(
    (a, b) => Number(!!a.seen_at) - Number(!!b.seen_at) || Date.parse(b.created_at) - Date.parse(a.created_at),
  );
  for (const r of sorted) {
    if (seen.has(r.media.id)) continue;
    seen.add(r.media.id);
    out.push(r);
    if (out.length >= max) break;
  }
  return out;
}

/** Multi-select toggle keeping the click order. */
export function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

export function personName(u: { username: string; display_name?: string | null }): string {
  return u.display_name?.trim() || u.username;
}

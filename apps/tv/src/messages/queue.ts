// Admin messages shown on the TV: a FIFO of unread messages, each shown once
// per app run (or until read). Pure; App feeds it from realtime "message"
// events and GET /messages at startup.
import type { Message } from "@martytv/contracts";

export class MessageQueue {
  private items: Message[] = [];
  private seen = new Set<string>();
  private listeners = new Set<() => void>();

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  private changed() {
    this.listeners.forEach((l) => l());
  }

  /** Adds an unread message not shown yet. Returns whether it was queued. */
  add(m: Message | null | undefined): boolean {
    if (!m || typeof m.id !== "string" || m.read_at) return false;
    if (this.seen.has(m.id) || this.items.some((x) => x.id === m.id)) return false;
    this.items = [...this.items, m];
    this.changed();
    return true;
  }

  /** Startup: the inbox (newest first) → oldest unread first. */
  addAll(list: readonly Message[]) {
    [...list].reverse().forEach((m) => this.add(m));
  }

  get current(): Message | null {
    return this.items[0] ?? null;
  }

  get size(): number {
    return this.items.length;
  }

  /** The current message was closed (read or dismissed): next one. */
  dismiss(id: string) {
    this.seen.add(id);
    const before = this.items.length;
    this.items = this.items.filter((m) => m.id !== id);
    if (this.items.length !== before) this.changed();
  }
}

/** Validates a realtime "message" payload. */
export function parseMessageEvent(p: unknown): Message | null {
  if (typeof p !== "object" || p === null) return null;
  const m = p as Partial<Message>;
  if (typeof m.id !== "string" || typeof m.title !== "string" || typeof m.body !== "string") return null;
  return {
    id: m.id,
    title: m.title.slice(0, 200),
    body: m.body.slice(0, 4000),
    from_name: typeof m.from_name === "string" ? m.from_name : "",
    created_at: typeof m.created_at === "string" ? m.created_at : new Date().toISOString(),
    read_at: typeof m.read_at === "string" ? m.read_at : null,
  };
}

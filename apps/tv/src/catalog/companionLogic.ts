// The TV «После титров» chat: what ▲▼ / OK can pick under the messages.
import type { Schemas } from "@martytv/contracts";

export type ChatAction = { kind: "followup"; text: string } | { kind: "ask" } | { kind: "new" };

/** The model's suggestions and «Задать вопрос» (while questions are left), then «Новый разговор». */
export function chatActions(chat: Pick<Schemas["AfterCreditsChat"], "followups" | "remaining" | "messages"> | undefined): ChatAction[] {
  if (!chat) return [];
  const out: ChatAction[] = [];
  if (chat.remaining > 0) {
    for (const f of chat.followups) out.push({ kind: "followup", text: f });
    out.push({ kind: "ask" });
  }
  if (chat.messages.length > 0) out.push({ kind: "new" });
  return out;
}

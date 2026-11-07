// «Ранее в сериале» / «После титров» on the TV details: full-screen panels
// opened from chips in the header's extras line (trivia.tsx). Like the
// trivia panels they own the keys while shown.
//   Recap: up to five big lines; Back closes.
//   After the credits: ◀ ▶ switch «Объяснение финала» / «Почему это важно»
//   / «Обсудить»; ▲▼ scroll (chat: pick a suggestion, «Задать вопрос»
//   opens the on-screen keyboard, «Новый разговор»); OK acts.
import { useEffect, useRef, useState } from "react";
import { ApiError } from "@martytv/contracts";
import { episodeCode, formatDate } from "@martytv/media-types";
import {
  afterScopeLabel,
  AFTER_TABS,
  CHAT_MAX,
  chatCanSend,
  companionErrorKey,
  companionRetryable,
  stepIndex,
  stepTab,
  useI18n,
  type AfterTab,
  type CompanionTopic,
  type MessageKey,
} from "@martytv/ui";
import { setFocus } from "../focus";
import { TasteNoteEditor } from "../settings/TasteNoteEditor";
import { useAfterChat, useAfterCredits, useRecap, useSendChat, type AfterCreditsChat } from "../catalog/companion";
import { chatActions } from "../catalog/companionLogic";
import { Loading, Shell, usePanelKeys } from "./trivia";

const codeOf = (err: unknown) => (err instanceof ApiError ? err.code : undefined);

function Failed({ error }: { error: unknown }) {
  const { t } = useI18n();
  const code = codeOf(error);
  return (
    <div data-testid="tv-companion-error" className="flex flex-1 flex-col items-center justify-center text-center">
      <p className="max-w-[1100px] text-4xl font-semibold leading-snug">{t(companionErrorKey(code))}</p>
      {companionRetryable(code) && (
        <span className="tv-focus is-focused mt-10 rounded-2xl bg-accent px-10 py-5 text-3xl font-semibold text-on-accent">{t("common.retry")} · OK</span>
      )}
    </div>
  );
}

/** Scrolls a box by ▲▼ (a page step) — for text that may not fit. */
function scrollBy(el: HTMLElement | null, dir: number) {
  if (el) el.scrollTop = Math.max(0, el.scrollTop + dir * 160);
}

export function RecapPanel({ id, title, profileId, lastWatched, onClose }: { id: string; title: string; profileId: string; lastWatched: string | null; onClose: () => void }) {
  const { t, locale } = useI18n();
  const q = useRecap(id, profileId, true);
  usePanelKeys((k, e) => {
    if (k === "back" || k === "stop") return onClose();
    if (k === "ok" && !e.repeat && q.isError && companionRetryable(codeOf(q.error))) void q.refetch();
  });
  const d = q.data;
  const last = lastWatched ? formatDate(lastWatched, locale) : null;
  return (
    <Shell
      testId="tv-recap-panel"
      heading={`↺ ${t("companion.recap_title", { title })}`}
      footer={
        <>
          <span>{d ? t("companion.recap_note") : ""}</span>
          <span className="ml-8 shrink-0">{t("companion.tv_hint")}</span>
        </>
      }
    >
      {q.isError ? (
        <Failed error={q.error} />
      ) : q.isPending || !d ? (
        <Loading label="companion.recap_loading" />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <p className="mt-4 text-[26px] text-muted">
            {t("companion.recap_through", { code: episodeCode(d.through.season, d.through.episode) })}
            {last ? ` · ${t("companion.recap_last", { date: last })}` : ""}
          </p>
          <ol data-testid="tv-recap-lines" className="mt-8 min-h-0 flex-1 overflow-hidden">
            {d.lines.map((l, i) => (
              <li key={i} className="mb-6 flex text-[36px] font-semibold leading-snug">
                <span className="mr-6 shrink-0 text-accent">•</span>
                <span>{l}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Shell>
  );
}

function TopicBody({ id, profileId, topic, box }: { id: string; profileId: string; topic: CompanionTopic; box: React.RefObject<HTMLDivElement | null> }) {
  const { t } = useI18n();
  const q = useAfterCredits(id, profileId, topic, true);
  if (q.isError) return <Failed error={q.error} />;
  if (q.isPending || !q.data) return <Loading label={topic === "ending" ? "companion.ending_loading" : "companion.significance_loading"} />;
  if (!q.data.known)
    return (
      <div data-testid="tv-after-unknown" className="flex flex-1 items-center justify-center">
        <p className="max-w-[1100px] text-center text-[34px] text-muted">{t("companion.unknown")}</p>
      </div>
    );
  return (
    <div ref={box} data-testid={`tv-after-${topic}`} className="mt-6 min-h-0 flex-1 overflow-hidden">
      {q.data.paragraphs.map((p, i) => (
        <p key={i} className="mb-6 text-[30px] leading-[1.45]">
          {p}
        </p>
      ))}
    </div>
  );
}


function ChatBody({ chat, sel, pending, error }: { chat: AfterCreditsChat | undefined; sel: number; pending: boolean; error: unknown }) {
  const box = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  useEffect(() => {
    // Newest messages in view.
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat?.messages.length, pending]);
  if (!chat) return <Loading label="companion.chat_thinking" />;
  const actions = chatActions(chat);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={box} data-testid="tv-chat" className="mt-6 min-h-0 flex-1 overflow-hidden">
        {chat.messages.length === 0 && <p className="mt-10 text-center text-[32px] text-muted">{t("companion.chat_empty")}</p>}
        {chat.messages.map((m, i) => (
          <div key={i} data-testid="tv-chat-message" data-role={m.role} className={`mb-4 flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <p className={`max-w-[1000px] rounded-card px-7 py-4 text-[28px] leading-snug ${m.role === "user" ? "bg-accent text-on-accent" : "bg-surface-2"}`}>{m.text}</p>
          </div>
        ))}
        {pending && <p className="text-[28px] text-muted">{t("companion.chat_thinking")}…</p>}
      </div>
      {error ? <p className="mt-3 text-[24px] text-danger">{t(companionErrorKey(codeOf(error)))}</p> : null}
      {chat.remaining === 0 && <p className="mt-3 text-[24px] text-muted">{t("companion.chat_full")}</p>}
      <div className="mt-4 flex flex-wrap">
        {actions.map((a, i) => (
          <span
            key={i}
            data-testid={`tv-chat-action-${a.kind}`}
            className={`tv-focus mb-3 mr-4 rounded-control px-6 py-3 text-[24px] font-semibold ${i === sel ? "is-focused bg-accent text-on-accent" : "bg-surface-2"}`}
          >
            {a.kind === "followup" ? a.text : a.kind === "ask" ? `⌨ ${t("companion.chat_ask")}` : t("companion.chat_new")}
          </span>
        ))}
      </div>
      <p className="mt-1 text-[20px] text-muted">
        {t("companion.chat_remaining", { n: chat.remaining })} · {t("companion.chat_hint")}
      </p>
    </div>
  );
}

export function AfterCreditsPanel({
  id,
  title,
  profileId,
  scope,
  season,
  onClose,
}: {
  id: string;
  title: string;
  profileId: string;
  scope: string;
  season: number | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<AfterTab>("ending");
  const [sel, setSel] = useState(0);
  const [typing, setTyping] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const chatQ = useAfterChat(id, profileId, tab === "chat");
  const send = useSendChat(id, profileId);
  const chat = chatQ.data;
  const actions = chatActions(chat);
  const ask = (message: string) => {
    if (!chat || !chatCanSend(message, chat.remaining) || send.isPending) return;
    send.mutate({ message: message.trim() }, { onSuccess: () => setSel(0) });
  };
  usePanelKeys((k, e) => {
    if (k === "back" || k === "stop") return onClose();
    if (k === "left" || k === "right") {
      setTab((x) => stepTab(x, k === "left" ? -1 : 1));
      setSel(0);
      return;
    }
    if (tab !== "chat") {
      if (k === "up" || k === "down") scrollBy(box.current, k === "up" ? -1 : 1);
      return;
    }
    if (k === "up" || k === "down") setSel((x) => stepIndex(x, k === "up" ? -1 : 1, actions.length));
    else if (k === "ok" && !e.repeat) {
      if (chatQ.isError) return void chatQ.refetch();
      const a = actions[Math.min(sel, actions.length - 1)];
      if (!a || send.isPending) return;
      if (a.kind === "followup") ask(a.text);
      else if (a.kind === "ask") setTyping(true);
      else send.mutate({ reset: true }, { onSuccess: () => setSel(0) });
    }
  });
  const sl = afterScopeLabel(scope, season);
  return (
    <>
      <Shell
        testId="tv-after-panel"
        heading={`◐ ${t("companion.after_title", { title })}`}
        badge={<span className="ml-6 shrink-0 rounded-full bg-danger px-5 py-1 text-[24px] font-bold text-white">{t("companion.spoilers")}</span>}
        footer={
          <>
            <span className="min-w-0 truncate">
              {t(sl.key, sl.vars)} · {t("companion.ai_note")}
            </span>
            <span className="ml-8 shrink-0">{t("companion.tv_after_hint")}</span>
          </>
        }
      >
        <div className="mt-6 flex">
          {AFTER_TABS.map((k) => (
            <span
              key={k}
              data-testid={`tv-after-tab-${k}`}
              data-active={tab === k || undefined}
              className={`mr-4 rounded-full px-7 py-2 text-[26px] font-semibold ${tab === k ? "bg-accent text-on-accent" : "bg-surface-2 text-muted"}`}
            >
              {t(`companion.${k}` as MessageKey)}
            </span>
          ))}
        </div>
        {tab === "chat" ? (
          chatQ.isError ? (
            <Failed error={chatQ.error} />
          ) : (
            <ChatBody chat={chat} sel={Math.min(sel, Math.max(0, actions.length - 1))} pending={send.isPending} error={send.error} />
          )
        ) : (
          <TopicBody key={tab} id={id} profileId={profileId} topic={tab} box={box} />
        )}
      </Shell>
      {typing && (
        <TasteNoteEditor
          initial=""
          title={t("companion.chat_ask")}
          hint={t("companion.chat_hint")}
          placeholder={t("companion.chat_placeholder")}
          max={CHAT_MAX}
          pausedNav={false}
          testId="tv-chat-editor"
          onClose={() => {
            setTyping(false);
            void setFocus("d-after");
          }}
          onSave={(text) => {
            setTyping(false);
            void setFocus("d-after");
            ask(text);
          }}
        />
      )}
    </>
  );
}

// «Ранее в сериале» / «После титров» on the title page: buttons beside
// «Цитаты» / «Факты», shown only when the API says the profile qualifies
// (a series resting ≥ 7 days; a finished movie or season). Each opens a
// sheet; the AI is asked when it opens (cached server-side after that).
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, type MediaDetail } from "@martytv/contracts";
import { episodeCode, formatDate } from "@martytv/media-types";
import {
  afterScopeLabel,
  AFTER_TABS,
  CHAT_MAX,
  chatCanSend,
  companionErrorKey,
  companionRetryable,
  Mascot,
  showAfterButton,
  showRecapButton,
  Spinner,
  useConstructivism,
  useI18n,
  type AfterTab,
  type MessageKey,
} from "@martytv/ui";
import { Button } from "../components";
import { Sheet } from "../remote/SendToTv";
import { useActiveProfile } from "../watch/ActiveProfile";
import { useMediaProgress } from "../watch/queries";
import { EXTRA_CHIP } from "./Trivia";
import { useAfterChat, useAfterCredits, useCompanion, useRecap, useSendChat } from "./companion";

const BTN = EXTRA_CHIP;

export function CompanionButtons({ m }: { m: Pick<MediaDetail, "id" | "title"> }) {
  const { t } = useI18n();
  const { profileId } = useActiveProfile();
  const progress = useMediaProgress(m.id);
  const status = useCompanion(m.id, profileId, progress.dataUpdatedAt);
  const [open, setOpen] = useState<"recap" | "after" | null>(null);
  const close = () => setOpen(null);
  return (
    <>
      {showRecapButton(status.data) && (
        <button type="button" data-testid="recap-button" onClick={() => setOpen("recap")} className={BTN}>
          <span aria-hidden className="text-base leading-none">↺</span>
          {t("companion.recap")}
        </button>
      )}
      {showAfterButton(status.data) && (
        <button type="button" data-testid="after-credits-button" onClick={() => setOpen("after")} className={BTN}>
          <span aria-hidden className="text-base leading-none">◐</span>
          {t("companion.after")}
        </button>
      )}
      {open === "recap" && createPortal(<RecapSheet id={m.id} title={m.title} profileId={profileId} lastWatched={status.data?.recap.last_watched_at ?? null} onClose={close} />, document.body)}
      {open === "after" && status.data && createPortal(<AfterSheet id={m.id} title={m.title} profileId={profileId} scope={status.data.after_credits} onClose={close} />, document.body)}
    </>
  );
}

function Thinking({ label }: { label: MessageKey }) {
  const { t } = useI18n();
  const cv = useConstructivism();
  return (
    <div data-testid="companion-loading" className="flex flex-col items-center gap-3 py-10 text-center">
      {cv ? <Spinner size={36} /> : <Mascot size={96} mood="thinking" animated />}
      <p className="font-semibold">{t(label)}…</p>
      <p className="text-sm text-muted">{t("trivia.slow_hint")}</p>
    </div>
  );
}

const codeOf = (err: unknown) => (err instanceof ApiError ? err.code : undefined);

function Failed({ error, busy, onRetry }: { error: unknown; busy: boolean; onRetry: () => void }) {
  const { t } = useI18n();
  const code = codeOf(error);
  return (
    <div className="space-y-3 py-4" data-testid="companion-error">
      <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
        {t(companionErrorKey(code))}
      </p>
      {companionRetryable(code) && (
        <Button variant="secondary" busy={busy} onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}

function RecapSheet({ id, title, profileId, lastWatched, onClose }: { id: string; title: string; profileId: string | null | undefined; lastWatched: string | null; onClose: () => void }) {
  const { t, locale } = useI18n();
  const q = useRecap(id, profileId, true);
  return (
    <Sheet title={t("companion.recap")} subtitle={title} onClose={onClose} wide testId="recap-sheet">
      {q.isPending && !q.error ? (
        <Thinking label="companion.recap_loading" />
      ) : q.error || !q.data ? (
        <Failed error={q.error} busy={q.isFetching} onRetry={() => void q.refetch()} />
      ) : (
        <div className="space-y-3 pt-1">
          <p className="text-sm text-muted">
            {t("companion.recap_through", { code: episodeCode(q.data.through.season, q.data.through.episode) })}
            {lastWatched ? ` · ${t("companion.recap_last", { date: formatDate(lastWatched, locale) ?? "" })}` : ""}
          </p>
          <ol className="space-y-2.5" data-testid="recap-lines">
            {q.data.lines.map((l, i) => (
              <li key={i} className="rounded-2xl bg-surface-2 px-4 py-3 text-[17px] leading-relaxed sm:px-5">
                {l}
              </li>
            ))}
          </ol>
          <p className="pt-1 text-xs text-muted">{t("companion.recap_note")}</p>
        </div>
      )}
    </Sheet>
  );
}

function AfterSheet({
  id,
  title,
  profileId,
  scope,
  onClose,
}: {
  id: string;
  title: string;
  profileId: string | null | undefined;
  scope: { scope: string; season: number | null };
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<AfterTab>("ending");
  const sl = afterScopeLabel(scope.scope, scope.season);
  return (
    <Sheet title={t("companion.after")} subtitle={title} onClose={onClose} wide testId="after-credits-sheet">
      <div className="space-y-3 pt-1">
        <p className="flex flex-wrap items-center gap-2 rounded-xl bg-danger/10 px-3 py-2 text-sm">
          <span className="rounded-full bg-danger/20 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-danger">{t("companion.spoilers")}</span>
          <span className="font-semibold">{t(sl.key, sl.vars)}</span>
          <span className="text-text/80">{t("companion.spoiler_note")}</span>
        </p>
        <div role="tablist" className="flex flex-wrap gap-1.5">
          {AFTER_TABS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              data-testid={`after-tab-${k}`}
              onClick={() => setTab(k)}
              className={`min-h-[40px] rounded-full px-4 text-sm font-semibold transition ${tab === k ? "bg-accent text-on-accent" : "border border-border hover:border-accent"}`}
            >
              {t(`companion.${k}` as MessageKey)}
            </button>
          ))}
        </div>
        {tab === "chat" ? <ChatPane id={id} profileId={profileId} /> : <TopicPane key={tab} id={id} profileId={profileId} topic={tab} />}
      </div>
    </Sheet>
  );
}

function TopicPane({ id, profileId, topic }: { id: string; profileId: string | null | undefined; topic: "ending" | "significance" }) {
  const { t } = useI18n();
  const q = useAfterCredits(id, profileId, topic, true);
  if (q.isPending && !q.error) return <Thinking label={topic === "ending" ? "companion.ending_loading" : "companion.significance_loading"} />;
  if (q.error || !q.data) return <Failed error={q.error} busy={q.isFetching} onRetry={() => void q.refetch()} />;
  if (!q.data.known)
    return (
      <p data-testid="after-unknown" className="rounded-xl bg-surface-2 px-3 py-6 text-center text-sm text-muted">
        {t("companion.unknown")}
      </p>
    );
  return (
    <div className="space-y-3" data-testid={`after-${topic}`}>
      {q.data.paragraphs.map((p, i) => (
        <p key={i} className="text-[16px] leading-relaxed">
          {p}
        </p>
      ))}
      <p className="text-xs text-muted">{t("companion.ai_note")}</p>
    </div>
  );
}

function ChatPane({ id, profileId }: { id: string; profileId: string | null | undefined }) {
  const { t } = useI18n();
  const q = useAfterChat(id, profileId, true);
  const send = useSendChat(id, profileId);
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const chat = q.data;
  const n = chat?.messages.length ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [n, send.isPending]);
  if (q.isPending && !q.error) return <Thinking label="companion.chat_thinking" />;
  if (q.error || !chat) return <Failed error={q.error} busy={q.isFetching} onRetry={() => void q.refetch()} />;
  const ask = (message: string) => {
    if (!chatCanSend(message, chat.remaining) || send.isPending) return;
    send.mutate({ message: message.trim() }, { onSuccess: () => setText("") });
  };
  return (
    <div className="space-y-3" data-testid="after-chat">
      {n === 0 && <p className="rounded-xl bg-surface-2 px-3 py-4 text-center text-sm text-muted">{t("companion.chat_empty")}</p>}
      <ul className="space-y-2">
        {chat.messages.map((m, i) => (
          <li key={i} data-testid="chat-message" data-role={m.role} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <p className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed ${m.role === "user" ? "bg-accent text-on-accent" : "bg-surface-2"}`}>{m.text}</p>
          </li>
        ))}
        {send.isPending && (
          <li className="flex justify-start">
            <p className="rounded-2xl bg-surface-2 px-4 py-2.5 text-sm text-muted">{t("companion.chat_thinking")}…</p>
          </li>
        )}
      </ul>
      <div ref={end} />
      {send.error ? <Failed error={send.error} busy={false} onRetry={() => ask(text)} /> : null}
      {chat.remaining > 0 ? (
        <>
          {chat.followups.length > 0 && !send.isPending && (
            <div className="flex flex-wrap gap-1.5">
              {chat.followups.map((f) => (
                <button key={f} type="button" onClick={() => ask(f)} className="min-h-[36px] rounded-full border border-border px-3 text-sm hover:border-accent">
                  {f}
                </button>
              ))}
            </div>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              ask(text);
            }}
          >
            <input
              value={text}
              maxLength={CHAT_MAX}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("companion.chat_placeholder")}
              data-testid="chat-input"
              className="min-h-[44px] min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 text-[15px] outline-none focus:border-accent"
            />
            <Button type="submit" busy={send.isPending} disabled={!chatCanSend(text, chat.remaining)} data-testid="chat-send">
              {t("companion.chat_send")}
            </Button>
          </form>
        </>
      ) : (
        <p className="text-sm text-muted">{t("companion.chat_full")}</p>
      )}
      <div className="flex items-center justify-between text-xs text-muted">
        <span>{t("companion.chat_remaining", { n: chat.remaining })}</span>
        {n > 0 && (
          <button type="button" className="underline-offset-2 hover:text-text hover:underline" onClick={() => send.mutate({ reset: true })}>
            {t("companion.chat_new")}
          </button>
        )}
      </div>
    </div>
  );
}

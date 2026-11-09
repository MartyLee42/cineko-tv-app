// «✦ ИИ» in search: the same «Спросить ИИ» as /ask and the TV — one call
// (POST /foryou/ask via useAsk), the same defaults (watched titles left out
// unless «Включая просмотренное»; the device's creativity), the same answer
// with «почему» per title, follow-ups that refine the ask, examples and the
// recent asks. Only the input differs: the search box (one line, no user
// bubble) instead of the chat composer. Sent only on Enter / the button:
// each ask counts towards the daily limit.
import { useState } from "react";
import { useI18n } from "@martytv/ui";
import { useCatalogLang } from "../catalog/queries";
import { ASK_INCLUDE_WATCHED_DEFAULT, askBody, askErrorKind, formOf, refinePrompt, type AskForm, type AskKind } from "../foryou/ask";
import { Answer, AskExamples, AskHistory, CreativityPicker, ErrorBubble, IncludeWatched, SparkIcon, Thinking } from "../foryou/AskPage";
import { sendFeedback, useAsk, useAskHistory, type ForYouAsk } from "../foryou/queries";
import { PlayOnTvProvider } from "../play/PlayOnTv";
import { SendToTvProvider } from "../remote/SendToTv";
import { useActiveProfile } from "../watch/ActiveProfile";

const ROW = "ask";
const RECENT = 5;

export interface AiSearchState {
  /** False without a profile or when AI is switched off on the server. */
  available: boolean;
  busy: boolean;
  /** Asks with the page's kind tab and the AI controls. */
  send: (prompt: string) => void;
  /** «Включая просмотренное» + «Точнее / Обычно / Смелее», next to the kind tabs. */
  controls: React.ReactNode;
  view: React.ReactNode;
}

/**
 * State + the answer view; the page owns the input and the kind tabs.
 * onPrompt / onKind put a refined or reopened ask back into them.
 */
export function useAiSearch({ kind, onPrompt, onKind, restore }: { kind: AskKind; onPrompt: (prompt: string) => void; onKind: (kind: AskKind) => void; restore: string }): AiSearchState {
  const { t } = useI18n();
  const lang = useCatalogLang();
  const { profileId } = useActiveProfile();
  const history = useAskHistory(profileId);
  const ask = useAsk();
  const [includeWatched, setIncludeWatched] = useState(ASK_INCLUDE_WATCHED_DEFAULT);
  const [current, setCurrent] = useState<ForYouAsk | null>(null);
  const [failed, setFailed] = useState<{ form: AskForm; error: unknown } | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const run = (form: AskForm) => {
    if (!profileId || ask.isPending) return;
    const body = askBody(form, profileId, lang);
    if (!body) return;
    setPending(body.prompt);
    setFailed(null);
    setCurrent(null);
    ask.mutate(body, {
      onSuccess: (r) => {
        setCurrent(r);
        r.items.forEach((it) => sendFeedback(profileId, it.media.id, "impression", ROW));
      },
      onError: (error) => setFailed({ form, error }),
      onSettled: () => setPending(null),
    });
  };
  const send = (prompt: string) => run({ prompt, kind, includeWatched });
  const reopen = (a: ForYouAsk) => {
    const f = formOf(a);
    setCurrent(a);
    setFailed(null);
    setIncludeWatched(f.includeWatched);
    onKind(f.kind);
    onPrompt(a.prompt);
  };

  const aiOff = history.data?.ai_enabled === false;
  // Back from a title: the same prompt's answer comes from the recent asks.
  const shown = current ?? (pending || failed || !restore.trim() ? null : (history.data?.items.find((a) => a.prompt === restore.trim()) ?? null));
  const recent = history.data?.items.slice(0, RECENT);
  const view = (
    <SendToTvProvider>
      <PlayOnTvProvider>
        <div className="space-y-4" data-testid="ai-search">
          {aiOff && !shown && <ErrorBubble kind="disabled" />}
          {pending && <Thinking />}
          {failed && <ErrorBubble kind={askErrorKind(failed.error)} onRetry={() => run(failed.form)} />}
          {shown && (
            <Answer
              ask={shown}
              profileId={profileId}
              deviceId={null}
              onFollowup={(f) => {
                // Refines the shown ask (its words + the chip), as on /ask and the TV.
                const next = refinePrompt(shown.prompt, f);
                onPrompt(next);
                send(next);
              }}
            />
          )}
          {!aiOff && !pending && !failed && !shown && (
            <div className="space-y-6">
              <div className="flex flex-col items-center gap-3 pt-8 text-center text-muted">
                <SparkIcon className="text-5xl text-accent opacity-70" />
                <p className="max-w-sm">{t("catalog.ai.hint")}</p>
              </div>
              <AskExamples
                disabled={ask.isPending}
                onPick={(p) => {
                  onPrompt(p);
                  send(p);
                }}
              />
              {!!recent?.length && <AskHistory items={recent} loading={false} activeId={undefined} onOpen={reopen} />}
            </div>
          )}
        </div>
      </PlayOnTvProvider>
    </SendToTvProvider>
  );
  const controls = (
    <>
      <IncludeWatched on={includeWatched} onChange={setIncludeWatched} />
      <CreativityPicker />
    </>
  );
  return { available: !!profileId && !aiOff, busy: ask.isPending, send, controls, view };
}

/** In regular results: one tap sends the same words to the AI. */
export function AskAiSuggestion({ q, onAsk }: { q: string; onAsk: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onAsk}
      data-testid="search-ask-ai"
      className="mb-4 flex w-full items-center gap-3 rounded-2xl border border-accent/40 bg-accent/10 px-4 py-3 text-left transition hover:bg-accent/20"
    >
      <SparkIcon className="shrink-0 text-xl text-accent" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{t("catalog.ai.suggest", { q })}</span>
        <span className="block text-xs text-muted">{t("catalog.ai.suggest_hint")}</span>
      </span>
    </button>
  );
}

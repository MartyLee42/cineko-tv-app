// «✦ ИИ» in search: the typed text goes to «Спросить ИИ» (POST /foryou/ask)
// and the answer — a short reply plus playable titles — shows right here.
// Sent only on Enter / the button: each ask counts towards the daily limit.
import { useState } from "react";
import { useI18n } from "@martytv/ui";
import { useCatalogLang } from "../catalog/queries";
import { askBody, askErrorKind, withFollowup, type AskKind } from "../foryou/ask";
import { Answer, ErrorBubble, SparkIcon, Thinking } from "../foryou/AskPage";
import { sendFeedback, useAsk, useAskHistory, type ForYouAsk } from "../foryou/queries";
import { PlayOnTvProvider } from "../play/PlayOnTv";
import { SendToTvProvider } from "../remote/SendToTv";
import { useActiveProfile } from "../watch/ActiveProfile";

const ROW = "ask";

export interface AiSearchState {
  /** False without a profile or when AI is switched off on the server. */
  available: boolean;
  busy: boolean;
  send: (prompt: string, kind: AskKind, includeWatched: boolean) => void;
  view: React.ReactNode;
}

/** State + the answer view; the page owns the input. A follow-up chip re-asks with the refined prompt (onPrompt updates the box). */
export function useAiSearch(onPrompt: (prompt: string) => void, restore: string): AiSearchState {
  const { t } = useI18n();
  const lang = useCatalogLang();
  const { profileId } = useActiveProfile();
  const history = useAskHistory(profileId);
  const ask = useAsk();
  const [current, setCurrent] = useState<ForYouAsk | null>(null);
  const [failed, setFailed] = useState<{ prompt: string; kind: AskKind; inc: boolean; error: unknown } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [last, setLast] = useState<{ kind: AskKind; inc: boolean }>({ kind: "any", inc: false });

  const send = (prompt: string, kind: AskKind, includeWatched: boolean) => {
    if (!profileId || ask.isPending) return;
    const body = askBody({ prompt, kind, includeWatched }, profileId, lang);
    if (!body) return;
    setPending(body.prompt);
    setLast({ kind, inc: includeWatched });
    setFailed(null);
    setCurrent(null);
    ask.mutate(body, {
      onSuccess: (r) => {
        setCurrent(r);
        r.items.forEach((it) => sendFeedback(profileId, it.media.id, "impression", ROW));
      },
      onError: (error) => setFailed({ prompt: body.prompt, kind, inc: includeWatched, error }),
      onSettled: () => setPending(null),
    });
  };

  const aiOff = history.data?.ai_enabled === false;
  // Back from a title: the same prompt's answer comes from the recent asks.
  const shown = current ?? (pending || failed || !restore.trim() ? null : (history.data?.items.find((a) => a.prompt === restore.trim()) ?? null));
  const view = (
    <SendToTvProvider>
      <PlayOnTvProvider>
        <div className="space-y-4" data-testid="ai-search">
          {pending && <Thinking />}
          {failed && <ErrorBubble kind={askErrorKind(failed.error)} onRetry={() => send(failed.prompt, failed.kind, failed.inc)} />}
          {shown && <Answer ask={shown} profileId={profileId} deviceId={null} onFollowup={(f) => {
                const next = withFollowup(shown.prompt, "", f);
                onPrompt(next);
                send(next, last.kind, last.inc);
              }} />}
          {!pending && !failed && !shown && (
            <div className="flex flex-col items-center gap-3 py-16 text-center text-muted">
              <SparkIcon className="text-5xl text-accent opacity-70" />
              <p className="max-w-sm">{t("catalog.ai.hint")}</p>
            </div>
          )}
        </div>
      </PlayOnTvProvider>
    </SendToTvProvider>
  );
  return { available: !!profileId && !aiOff, busy: ask.isPending, send, view };
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

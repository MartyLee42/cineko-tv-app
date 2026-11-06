import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { MediaSummary } from "@martytv/contracts";
import { imageUrl, placeholderColor, formatRating } from "@martytv/media-types";
import { AI_CREATIVITY, CvIcon, Mascot, readAICreativity, translate, useConstructivism, useI18n, writeAICreativity, type AICreativity, type MascotMood, type MessageKey } from "@martytv/ui";
import { CatalogPage, Img } from "../catalog/components";
import { useCatalogConfig, useCatalogLang } from "../catalog/queries";
import { CastIcon, DeviceIcon, PlayIcon, TvIcon } from "../icons";
import { NoProfile } from "../pages/HistoryPage";
import { PlayOnTvProvider, usePlayOnTv, useWatchHere } from "../play/PlayOnTv";
import { SendToTvProvider, useSendToTv } from "../remote/SendToTv";
import { useActiveProfile } from "../watch/ActiveProfile";
import {
  ASK_ERROR,
  ASK_EXAMPLES,
  ASK_MAX,
  askBody,
  askErrorKind,
  askTarget,
  askWhen,
  cleanPrompt,
  exampleLabel,
  examplePrompt,
  withFollowup,
  type AskForm,
  type AskKind,
} from "./ask";
import { sendFeedback, trackOpen, useAsk, useAskHistory, useDismiss, type ForYouAsk } from "./queries";
import { TasteLink } from "./TasteCard";

const ROW = "ask";
const KINDS: AskKind[] = ["any", "movie", "series"];

/** «Спросить ИИ»: describe what you want, get a short answer + playable titles with «почему». */
export function AskPage() {
  return (
    <SendToTvProvider>
      <PlayOnTvProvider>
        <Ask />
      </PlayOnTvProvider>
    </SendToTvProvider>
  );
}

function Ask() {
  const { t } = useI18n();
  const lang = useCatalogLang();
  const { search } = useLocation();
  const { profile, profiles, profileId: activeId } = useActiveProfile();
  const target = askTarget(search, profiles.map((p) => p.id));
  const profileId = target.profileId ?? activeId;
  const history = useAskHistory(profileId);
  const ask = useAsk();
  const [form, setForm] = useState<AskForm>({ prompt: "", kind: "any", includeWatched: false });
  const [current, setCurrent] = useState<ForYouAsk | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ prompt: string; error: unknown } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const thread = useRef<HTMLDivElement>(null);

  const send = (text?: string) => {
    if (!profileId || ask.isPending) return;
    const body = askBody({ ...form, prompt: text ?? form.prompt }, profileId, lang, target.deviceId);
    if (!body) {
      input.current?.focus();
      return;
    }
    setPending(body.prompt);
    setFailed(null);
    setCurrent(null);
    setForm((f) => ({ ...f, prompt: "" }));
    ask.mutate(body, {
      onSuccess: (r) => {
        setCurrent(r);
        r.items.forEach((it) => sendFeedback(profileId, it.media.id, "impression", ROW));
      },
      onError: (error) => setFailed({ prompt: body.prompt, error }),
      onSettled: () => setPending(null),
    });
  };
  // Keep the newest exchange in view.
  useEffect(() => {
    if (pending || current || failed) thread.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [pending, current, failed]);

  const followup = (text: string) => {
    setForm((f) => ({ ...f, prompt: withFollowup(f.prompt, current?.prompt ?? "", text) }));
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };
  const reset = () => {
    setCurrent(null);
    setFailed(null);
    setForm((f) => ({ ...f, prompt: "" }));
    input.current?.focus();
  };

  if (!profile && !target.profileId) return <NoProfile />;
  const empty = !pending && !current && !failed;
  const aiOff = history.data?.ai_enabled === false;
  return (
    <CatalogPage>
      <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-5">
          <header className="flex items-start justify-between gap-3">
            <div>
              <h1 className="flex items-center gap-2.5 text-2xl font-extrabold sm:text-3xl">
                <SparkIcon className="text-accent" /> {t("ask.title")}
              </h1>
              <p className="mt-1 text-sm text-muted">{t("ask.subtitle")}</p>
              <TasteLink className="mt-1 inline-block" />
            </div>
            {!empty && (
              <button type="button" onClick={reset} data-testid="ask-new" className="min-h-[40px] shrink-0 rounded-full bg-surface-2 px-4 text-sm font-semibold hover:bg-border">
                + {t("ask.new")}
              </button>
            )}
          </header>

          {target.deviceId && (
            <p data-testid="ask-for-tv" className="flex items-center gap-2 rounded-2xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm font-medium">
              <TvIcon className="shrink-0 text-accent" /> {t("ask.for_tv")}
            </p>
          )}

          {aiOff && empty && <ErrorBubble kind="disabled" />}

          {empty && !aiOff && (
            <div className="flex items-center gap-4 rounded-3xl border border-border bg-gradient-to-br from-accent/10 via-surface to-surface p-5 sm:p-6">
              <Mascot size={64} className="shrink-0" />
              <p className="text-sm leading-relaxed text-text/85 sm:text-base">{t("ask.card.text")}</p>
            </div>
          )}

          <div ref={thread} className="scroll-mt-24 space-y-4" data-testid="ask-thread">
            {(pending ?? current?.prompt ?? failed?.prompt) && <UserBubble text={(pending ?? current?.prompt ?? failed?.prompt)!} />}
            {pending && <Thinking />}
            {failed && <ErrorBubble kind={askErrorKind(failed.error)} onRetry={() => send(failed.prompt)} />}
            {current && <Answer ask={current} profileId={profileId} deviceId={target.deviceId} onFollowup={followup} />}
          </div>

          <Composer
            form={form}
            setForm={setForm}
            inputRef={input}
            busy={ask.isPending}
            disabled={aiOff}
            onSend={() => send()}
            onExample={(text) => send(text)}
            showExamples={empty || !!failed}
          />
        </div>

        <History items={history.data?.items} loading={history.isPending} activeId={current?.id} onOpen={(a) => { setCurrent(a); setFailed(null); }} />
      </div>
    </CatalogPage>
  );
}

// ---------------------------------------------------------------- composer

function Composer({
  form,
  setForm,
  inputRef,
  busy,
  disabled,
  onSend,
  onExample,
  showExamples,
}: {
  form: AskForm;
  setForm: (f: (f: AskForm) => AskForm) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  busy: boolean;
  disabled: boolean;
  onSend: () => void;
  onExample: (prompt: string) => void;
  showExamples: boolean;
}) {
  const { t, locale } = useI18n();
  const ok = !!cleanPrompt(form.prompt);
  const len = [...form.prompt].length;
  return (
    <div className="space-y-3">
      {showExamples && (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{t("ask.examples")}</p>
          <div className="flex flex-wrap gap-2" data-testid="ask-examples">
            {ASK_EXAMPLES.map((e) => (
              <button
                key={e}
                type="button"
                disabled={busy || disabled}
                data-testid={`ask-example-${e}`}
                onClick={() => onExample(t(examplePrompt(e)))}
                className="min-h-[40px] rounded-full border border-border bg-surface px-4 text-sm font-medium transition hover:border-accent hover:bg-accent/10 disabled:opacity-50"
              >
                {t(exampleLabel(e))}
              </button>
            ))}
          </div>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSend();
        }}
        className="rounded-3xl border border-border bg-surface p-2 shadow-xl shadow-black/10 focus-within:border-accent"
      >
        <textarea
          ref={inputRef}
          value={form.prompt}
          onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
          maxLength={ASK_MAX}
          rows={2}
          disabled={disabled}
          aria-label={translate(locale, "ask.title")}
          placeholder={t("ask.placeholder")}
          data-testid="ask-input"
          className="block max-h-48 min-h-[56px] w-full resize-y bg-transparent px-3 py-2.5 text-base outline-none placeholder:text-muted"
        />
        <div className="flex flex-wrap items-center gap-2 px-1 pb-1 pt-1">
          <div role="radiogroup" aria-label={t("ask.kind")} className="inline-flex rounded-full bg-surface-2 p-1" data-testid="ask-kind">
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={form.kind === k}
                onClick={() => setForm((f) => ({ ...f, kind: k }))}
                className={`min-h-[32px] rounded-full px-3 text-xs font-semibold transition sm:text-sm ${form.kind === k ? "bg-accent text-on-accent" : "text-muted hover:text-text"}`}
              >
                {t(`ask.kind.${k}` as MessageKey)}
              </button>
            ))}
          </div>
          <label className="flex min-h-[36px] cursor-pointer items-center gap-2 px-1 text-xs text-muted sm:text-sm">
            <input
              type="checkbox"
              checked={form.includeWatched}
              onChange={(e) => setForm((f) => ({ ...f, includeWatched: e.target.checked }))}
              className="h-4 w-4 accent-[rgb(var(--mt-accent))]"
              data-testid="ask-watched"
            />
            {t("ask.include_watched")}
          </label>
          <CreativityPicker />
          <span className="ml-auto flex items-center gap-2">
            {len > ASK_MAX - 100 && <span className="text-xs tabular-nums text-muted">{len}/{ASK_MAX}</span>}
            <button
              type="submit"
              disabled={!ok || busy || disabled}
              data-testid="ask-send"
              className="inline-flex min-h-[44px] items-center gap-2 rounded-2xl bg-accent px-5 font-bold text-on-accent transition hover:bg-accent-strong active:scale-[.98] disabled:opacity-40"
            >
              <SparkIcon /> {t("ask.send")}
            </button>
          </span>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------- bubbles

function UserBubble({ text }: { text: string }) {
  const { t } = useI18n();
  return (
    <div className="flex justify-end" data-testid="ask-user">
      <p className="max-w-[85%] whitespace-pre-wrap rounded-3xl rounded-br-md bg-accent px-4 py-2.5 text-[15px] font-medium text-on-accent shadow-lg shadow-accent/15">
        <span className="sr-only">{t("ask.you")}: </span>
        {text}
      </p>
    </div>
  );
}

function AiRow({ children, testId, mood }: { children: ReactNode; testId?: string; mood?: MascotMood }) {
  return (
    <div className="flex items-start gap-3" data-testid={testId}>
      <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-surface-2">
        <Mascot size={30} mood={mood} animated={mood === "thinking"} />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function Thinking() {
  const { t } = useI18n();
  return (
    <AiRow testId="ask-thinking" mood="thinking">
      <div className="inline-flex flex-col gap-1.5 rounded-3xl rounded-tl-md border border-border bg-surface px-5 py-3.5" role="status" aria-live="polite">
        <span className="flex items-center gap-3">
          <span className="flex items-end gap-1.5" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-2.5 w-2.5 animate-bounce rounded-full bg-accent" style={{ animationDelay: `${i * 0.16}s`, animationDuration: "1s" }} />
            ))}
          </span>
          <span className="font-semibold">{t("ask.thinking")}</span>
        </span>
        <span className="text-xs text-muted">{t("ask.thinking_hint")}</span>
      </div>
    </AiRow>
  );
}

export function ErrorBubble({ kind, onRetry }: { kind: keyof typeof ASK_ERROR; onRetry?: () => void }) {
  const { t } = useI18n();
  const e = ASK_ERROR[kind];
  return (
    <AiRow testId="ask-error" mood="error">
      <div data-kind={kind} role="alert" className="rounded-3xl rounded-tl-md border border-danger/40 bg-danger/10 px-5 py-4">
        {e.title && <p className="font-bold">{t(e.title)}</p>}
        <p className="text-sm text-text/85">{t(e.text)}</p>
        {e.retry && onRetry && (
          <button type="button" onClick={onRetry} data-testid="ask-retry" className="mt-3 min-h-[40px] rounded-xl bg-surface-2 px-4 text-sm font-semibold hover:bg-border">
            {t("ask.retry")}
          </button>
        )}
      </div>
    </AiRow>
  );
}

export function Answer({ ask, profileId, deviceId, onFollowup }: { ask: ForYouAsk; profileId: string | undefined; deviceId: string | null; onFollowup: (s: string) => void }) {
  const { t, locale } = useI18n();
  return (
    <div className="space-y-4" data-testid="ask-answer" data-ask-id={ask.id}>
      <AiRow>
        <div className="rounded-3xl rounded-tl-md border border-border bg-surface px-5 py-3.5">
          {ask.refused && (
            <span data-testid="ask-refused" className="mb-1.5 inline-block rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-semibold text-muted">
              {t("ask.refused_badge")}
            </span>
          )}
          <p className="text-[15px] leading-relaxed" data-testid="ask-answer-text">
            {ask.answer}
          </p>
          <p className="mt-1.5 flex flex-wrap gap-x-3 text-[11px] text-muted">
            {ask.tokens > 0 && <span data-testid="ask-tokens">{t("ask.tokens", { tokens: ask.tokens.toLocaleString(locale) })}</span>}
            {deviceId && ask.sent_to_device !== undefined && (
              <span data-testid="ask-sent" className={ask.sent_to_device ? "font-semibold text-accent" : ""}>
                {t(ask.sent_to_device ? "ask.sent_tv" : "ask.sent_tv_offline")}
              </span>
            )}
          </p>
        </div>
      </AiRow>
      {!ask.refused && ask.items.length === 0 && <p className="pl-[52px] text-sm text-muted">{t("ask.empty_items")}</p>}
      {ask.items.length > 0 && (
        <ul className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 sm:pl-[52px] xl:grid-cols-4" data-testid="ask-items">
          {ask.items.map((it) => (
            <AskCard key={it.media.id} m={it.media} why={it.why} profileId={profileId} />
          ))}
        </ul>
      )}
      {ask.followups.length > 0 && (
        <div className="sm:pl-[52px]">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{t("ask.followups")}</p>
          <div className="flex flex-wrap gap-2" data-testid="ask-followups">
            {ask.followups.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => onFollowup(f)}
                className="min-h-[38px] rounded-full border border-accent/50 bg-accent/10 px-3.5 text-sm font-medium transition hover:bg-accent/20"
              >
                ↳ {f}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- results

function AskCard({ m, why, profileId }: { m: MediaSummary; why: string; profileId: string | undefined }) {
  const { t } = useI18n();
  const { data: cfg } = useCatalogConfig();
  const navigate = useNavigate();
  const watchHere = useWatchHere();
  const { play } = usePlayOnTv();
  const { request } = useSendToTv();
  const dismiss = useDismiss();
  const [hidden, setHidden] = useState(false);
  const target = { media_id: m.id, label: m.title };
  const open = () => trackOpen(profileId, m.id, ROW);
  const played = () => sendFeedback(profileId, m.id, "play", ROW);
  const rating = formatRating(m.kp_rating ?? m.rating);
  const watched = m.me?.completed || m.me?.rating != null;

  return (
    <li data-testid="ask-card" data-media-id={m.id} data-hidden={hidden ? "1" : "0"} className="flex min-w-0 flex-col">
      <Link
        to={`/title/${m.id}`}
        onClick={open}
        className={`group relative block aspect-[2/3] overflow-hidden rounded-2xl shadow-lg shadow-black/30 ring-1 ring-black/5 transition ${hidden ? "opacity-30 grayscale" : "hover:-translate-y-0.5"}`}
        style={{ background: placeholderColor(m.title) }}
      >
        <Img src={imageUrl(cfg, m.poster_path, "w342")} alt={m.title} className="absolute inset-0 h-full w-full object-cover" fallback={<span className="absolute inset-0 flex items-center p-3 text-center text-sm font-semibold text-white/90">{m.title}</span>} />
        {rating && <span className="absolute left-1.5 top-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-semibold text-white">★ {rating}</span>}
        {watched && <span className="absolute right-1.5 top-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-semibold text-white">✓</span>}
      </Link>
      <p className="mt-2 line-clamp-2 text-sm font-semibold leading-snug">{m.title}</p>
      <p className="text-xs text-muted">{[m.year, t(`catalog.kind.${m.kind}` as MessageKey)].filter(Boolean).join(" · ")}</p>
      {why && (
        <p className="mt-1.5 border-l-2 border-accent pl-2 text-[13px] leading-snug text-text/85" data-testid="ask-why">
          <span className="sr-only">{t("ask.why")}: </span>
          {why}
        </p>
      )}
      {hidden ? (
        <p className="mt-2 flex items-center gap-2 text-xs text-muted">
          {t("ask.hidden")}
          <button
            type="button"
            data-testid="ask-undo"
            onClick={() => {
              setHidden(false);
              dismiss.mutate({ mediaId: m.id, rowId: ROW, undo: true });
            }}
            className="font-semibold text-text underline"
          >
            {t("ask.undo")}
          </button>
        </p>
      ) : (
        <div className="mt-auto grid grid-cols-2 gap-1.5 pt-2.5">
          <button
            type="button"
            data-testid="ask-watch"
            onClick={() => {
              if (m.kind === "movie") {
                played();
                watchHere(target);
              } else {
                open();
                navigate(`/title/${m.id}`);
              }
            }}
            className="inline-flex min-h-[38px] min-w-0 items-center justify-center gap-1.5 [&_svg]:shrink-0 rounded-xl bg-accent px-2 text-xs font-bold text-on-accent hover:bg-accent-strong"
          >
            {m.kind === "movie" ? <DeviceIcon /> : <PlayIcon />} {t("ask.watch")}
          </button>
          <button
            type="button"
            data-testid="ask-tv"
            title={t("ask.on_tv")}
            onClick={() => {
              if (m.kind === "movie") {
                played();
                play(target);
              } else request({ media_id: m.id });
            }}
            className="inline-flex min-h-[38px] min-w-0 items-center justify-center gap-1.5 [&_svg]:shrink-0 rounded-xl border border-border bg-surface-2 px-2 text-xs font-semibold hover:border-accent"
          >
            <CastIcon /> {t("ask.on_tv")}
          </button>
          <button
            type="button"
            data-testid="ask-dismiss"
            onClick={() => {
              setHidden(true);
              dismiss.mutate({ mediaId: m.id, rowId: ROW });
            }}
            className="col-span-2 min-h-[32px] rounded-lg text-xs text-muted hover:bg-surface-2 hover:text-danger"
          >
            {t("ask.not_interested")}
          </button>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- history

function History({ items, loading, activeId, onOpen }: { items: ForYouAsk[] | undefined; loading: boolean; activeId: string | undefined; onOpen: (a: ForYouAsk) => void }) {
  const { t, locale } = useI18n();
  const now = new Date();
  return (
    <aside className="lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto" aria-labelledby="ask-history-title" data-testid="ask-history">
      <h2 id="ask-history-title" className="mb-3 text-sm font-bold uppercase tracking-wider text-muted">
        {t("ask.history")}
      </h2>
      {loading ? (
        <div className="space-y-2" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-2xl bg-surface-2" />
          ))}
        </div>
      ) : !items?.length ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted">{t("ask.history_empty")}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => onOpen(a)}
                aria-current={a.id === activeId}
                data-testid="ask-history-item"
                className={`w-full rounded-2xl border px-3.5 py-2.5 text-left transition ${a.id === activeId ? "border-accent bg-accent/10" : "border-border bg-surface hover:border-muted"}`}
              >
                <span className="line-clamp-2 text-sm font-medium">{a.prompt}</span>
                <span className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                  <span>{askWhen(a.created_at, now, locale)}</span>
                  <span aria-hidden>·</span>
                  <span>{a.refused ? t("ask.refused_badge") : t("ask.history_count", { count: a.items.length })}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------- entry card + icon

/** Prominent «Спросить ИИ» card for Home and Обзор (next to «Удиви меня!»). */
export function AskAiCard({ className = "" }: { className?: string }) {
  const { t } = useI18n();
  return (
    <Link
      to="/ask"
      data-testid="ask-card-entry"
      className={`group flex items-center gap-4 overflow-hidden rounded-3xl border border-accent/30 bg-gradient-to-r from-accent/20 via-accent/5 to-surface p-4 transition hover:border-accent sm:p-5 ${className}`}
    >
      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-bg/60 transition group-hover:scale-105">
        <Mascot size={44} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-lg font-extrabold">
          <SparkIcon className="text-accent" /> {t("ask.card.title")}
        </span>
        <span className="mt-0.5 block text-sm text-muted">{t("ask.card.text")}</span>
      </span>
      <span className="hidden min-h-[44px] shrink-0 items-center rounded-xl bg-accent px-5 font-bold text-on-accent group-hover:bg-accent-strong sm:inline-flex">
        {t("ask.card.cta")}
      </span>
    </Link>
  );
}

export const SparkIcon = (p: React.SVGProps<SVGSVGElement>) =>
  useConstructivism() ? (
    <CvIcon glyph="spark" {...p} />
  ) : (
  <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
  </svg>
);

/** «Точнее / Обычно / Смелее»: nudges the admin's temperature; remembered on this device. */
export function CreativityPicker() {
  const { t } = useI18n();
  const [v, setV] = useState<AICreativity>(readAICreativity);
  return (
    <div role="radiogroup" aria-label={t("ai.creativity")} title={t("ai.creativity.hint")} className="inline-flex rounded-full bg-surface-2 p-1" data-testid="ask-creativity">
      {AI_CREATIVITY.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={v === c}
          data-creativity={c}
          onClick={() => {
            setV(c);
            writeAICreativity(c);
          }}
          className={`min-h-[32px] rounded-full px-3 text-xs font-semibold transition sm:text-sm ${v === c ? "bg-accent text-on-accent" : "text-muted hover:text-text"}`}
        >
          {t(`ai.creativity.${c}` as MessageKey)}
        </button>
      ))}
    </div>
  );
}

// «Цитаты» / «Факты» on the TV details: two chips in the header (beside the
// awards line) and the full-screen panels they open. Like AwardsPanel the
// panels listen on window and claim the keys, so spatial focus stays on the
// chip and closing returns to it.
//   Quotes: one quote at a time, large and centred; ◀ ▶ flip, «3 / 12».
//   Facts: a vertical list, focus card by card (▲▼); OK reveals a spoiler.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MediaDetail } from "@martytv/contracts";
import { catalogLang } from "@martytv/media-types";
import {
  factsSourceKey,
  formatQuote,
  formatSpeaker,
  isFactHidden,
  Mascot,
  revealFact,
  SovietEmblem,
  stepIndex,
  useConstructivism,
  useI18n,
  type MediaFacts,
  type MediaQuotes,
  type MessageKey,
} from "@martytv/ui";
import { FocusButton } from "../focus";
import { playerKey, type PlayerKey } from "../player/keys";
import { claimKeys } from "../remote/keyOwner";
import { AwardsLine } from "./awards";

/** What a panel needs from its react-query result. */
export interface TriviaQuery<T> {
  data?: T;
  isPending: boolean;
  isError: boolean;
  refetch: () => unknown;
}

/** A chip of the header's secondary line. */
export interface ExtraChip {
  focusKey: string;
  testId: string;
  label: string;
  onPress: () => void;
}

/**
 * The header's secondary line: «🏆 Награды ▸» (when any) then «❝ Цитаты»
 * (null = hidden: none found) and «✦ Факты».
 */
export function ExtrasLine({
  awards,
  onAwards,
  onQuotes,
  onFacts,
  extra = [],
  square = false,
  className = "",
}: {
  awards: MediaDetail["awards"] | undefined;
  onAwards: (() => void) | null;
  onQuotes: (() => void) | null;
  onFacts: (() => void) | null;
  /** More chips after «Факты» (the watch companion). */
  extra?: ExtraChip[];
  /** Терминал: square label chips. */
  square?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const hasAwards = !!awards?.length && !!onAwards;
  if (!hasAwards && !onQuotes && !onFacts && extra.length === 0) return null;
  const chip = `tv-chip ml-3 flex h-[52px] shrink-0 items-center whitespace-nowrap bg-surface-2 px-5 text-[23px] font-semibold text-text ${square ? "t-label" : "rounded-control"}`;
  return (
    <div data-testid="tv-extras-line" className={`flex items-center ${className}`}>
      {hasAwards && <AwardsLine awards={awards} onOpen={onAwards} className="min-w-0 mr-1" />}
      {onQuotes && (
        <FocusButton focusKey="d-quotes" onPress={onQuotes} className={`${chip} ${hasAwards ? "" : "!ml-4"}`}>
          <span data-testid="tv-quotes-button">❝ {t("trivia.quotes")}</span>
        </FocusButton>
      )}
      {onFacts && (
        <FocusButton focusKey="d-facts" onPress={onFacts} className={`${chip} ${hasAwards || onQuotes ? "" : "!ml-4"}`}>
          <span data-testid="tv-facts-button">✦ {t("trivia.facts")}</span>
        </FocusButton>
      )}
      {extra.map((x, i) => (
        <FocusButton key={x.focusKey} focusKey={x.focusKey} onPress={x.onPress} className={`${chip} ${hasAwards || onQuotes || onFacts || i > 0 ? "" : "!ml-4"}`}>
          <span data-testid={x.testId}>{x.label}</span>
        </FocusButton>
      ))}
    </div>
  );
}

/** Window key handling while a panel is shown (the newest claim acts). */
export function usePanelKeys(onKey: (k: PlayerKey, e: KeyboardEvent) => void) {
  const handler = useRef(onKey);
  useEffect(() => {
    handler.current = onKey;
  });
  useEffect(() => {
    const c = claimKeys();
    const listener = (e: KeyboardEvent) => {
      if (!c.top) return;
      const k = playerKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      handler.current(k, e);
    };
    window.addEventListener("keydown", listener, true);
    return () => {
      window.removeEventListener("keydown", listener, true);
      c.release();
    };
  }, []);
}

export function Shell({ testId, heading, badge, footer, children }: { testId: string; heading: string; badge?: ReactNode; footer: ReactNode; children: ReactNode }) {
  return (
    // Fixed over the whole 1920×1080 canvas, like AwardsPanel.
    <div data-testid={testId} className="fixed left-0 top-0 z-30 flex h-[1080px] w-[1920px] items-center justify-center bg-black/70">
      <div className="flex h-[900px] w-[1400px] flex-col rounded-card bg-surface px-16 py-12 shadow-2xl">
        <div className="flex items-center">
          <h2 className="min-w-0 truncate text-5xl font-bold leading-tight">{heading}</h2>
          {badge}
        </div>
        {children}
        <div className="mt-6 flex items-center justify-between text-[20px] text-muted">{footer}</div>
      </div>
    </div>
  );
}

/** Slow first fetch: the thinking mascot (Конструктивизм: the emblem). */
export function Loading({ label }: { label: MessageKey }) {
  const { t } = useI18n();
  const cv = useConstructivism();
  return (
    <div data-testid="tv-trivia-loading" className="flex flex-1 items-center justify-center">
      <span className="tv-loader-float flex h-[150px] w-[150px] items-center justify-center">{cv ? <SovietEmblem size={140} /> : <Mascot size={150} mood="thinking" />}</span>
      <div className="ml-10">
        <p className="flex items-center text-[44px] font-bold">
          {t(label)}
          <span className="ml-5 flex">
            {[1, 2, 3].map((i) => (
              <span key={i} className={`tv-dot tv-dot-${i} mr-3 inline-block h-[16px] w-[16px] rounded-full bg-accent`} />
            ))}
          </span>
        </p>
        <p className="mt-3 text-[26px] text-muted">{t("trivia.slow_hint")}</p>
      </div>
    </div>
  );
}

function Failed() {
  const { t } = useI18n();
  return (
    <div data-testid="tv-trivia-error" className="flex flex-1 flex-col items-center justify-center text-center">
      <p className="text-4xl font-semibold">{t("trivia.load_error")}</p>
      {/* OK retries (the panel owns the keys); shown focused so it reads as the action. */}
      <span className="tv-focus is-focused mt-10 rounded-2xl bg-accent px-10 py-5 text-3xl font-semibold text-on-accent">{t("common.retry")} · OK</span>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div data-testid="tv-trivia-empty" className="flex flex-1 items-center justify-center">
      <p className="text-[34px] text-muted">{text}</p>
    </div>
  );
}

/** Font size of a quote by its length: short lines big, long ones still fit. */
function quoteSize(text: string): number {
  return text.length < 90 ? 60 : text.length < 180 ? 48 : text.length < 320 ? 38 : 31;
}

export function QuotesPanel({ title, q, onClose }: { title: string; q: TriviaQuery<MediaQuotes>; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [i, setI] = useState(0);
  const items = q.data?.items ?? [];
  const n = items.length;
  usePanelKeys((k, e) => {
    if (k === "back" || k === "stop") return onClose();
    if (q.isError) {
      if (k === "ok" && !e.repeat) void q.refetch();
      return;
    }
    if (k === "left") setI((x) => stepIndex(x, -1, n, true));
    else if (k === "right" || (k === "ok" && !e.repeat)) setI((x) => stepIndex(x, 1, n, true));
  });
  const cur = items[Math.min(i, Math.max(0, n - 1))];
  const lang = q.data?.lang ?? catalogLang(locale);
  const otherLang = q.data && n > 0 && q.data.lang !== catalogLang(locale);
  return (
    <Shell
      testId="tv-quotes-panel"
      heading={`❝ ${t("trivia.quotes_title", { title })}`}
      footer={
        <>
          <span>{q.data?.source === "wikiquote" ? t("trivia.source.wikiquote") : ""}</span>
          <span>{n > 1 ? t("trivia.tv_quotes_hint") : `${t("common.close")}: ←`}</span>
        </>
      }
    >
      {q.isError ? (
        <Failed />
      ) : q.isPending ? (
        <Loading label="trivia.quotes_loading" />
      ) : !cur ? (
        <Empty text={t("trivia.quotes_empty")} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {otherLang && <p className="mt-4 text-[22px] text-muted">{t(`trivia.other_lang_${q.data!.lang}` as MessageKey)}</p>}
          <div className="flex min-h-0 flex-1 items-center">
            <span className={`w-[80px] shrink-0 text-[64px] font-bold ${n > 1 ? "text-muted" : "opacity-0"}`}>◀</span>
            <figure key={i} data-testid="tv-quote" className="flex min-w-0 flex-1 flex-col items-center overflow-hidden px-6 text-center">
              <blockquote className="font-semibold leading-snug" style={{ fontSize: quoteSize(cur.text) }} lang={lang}>
                {formatQuote(cur.text, lang)}
              </blockquote>
              {formatSpeaker(cur.speaker) && <figcaption className="mt-8 text-[32px] text-muted">{formatSpeaker(cur.speaker)}</figcaption>}
            </figure>
            <span className={`w-[80px] shrink-0 text-right text-[64px] font-bold ${n > 1 ? "text-muted" : "opacity-0"}`}>▶</span>
          </div>
          <p data-testid="tv-quote-counter" className="text-center font-mono text-[28px] text-muted">
            {t("trivia.counter", { i: Math.min(i, n - 1) + 1, n })}
          </p>
        </div>
      )}
    </Shell>
  );
}

export function FactsPanel({ title, q, onClose }: { title: string; q: TriviaQuery<MediaFacts>; onClose: () => void }) {
  const { t } = useI18n();
  const [i, setI] = useState(0);
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());
  const box = useRef<HTMLDivElement>(null);
  const cards = useRef<(HTMLDivElement | null)[]>([]);
  const items = q.data?.items ?? [];
  const n = items.length;
  usePanelKeys((k, e) => {
    if (k === "back" || k === "stop") return onClose();
    if (q.isError) {
      if (k === "ok" && !e.repeat) void q.refetch();
      return;
    }
    if (k === "up") setI((x) => stepIndex(x, -1, n));
    else if (k === "down") setI((x) => stepIndex(x, 1, n));
    else if (k === "ok" && !e.repeat && items[i] && isFactHidden(items[i], i, revealed)) setRevealed((r) => revealFact(r, i));
  });
  // Keep the focused card (and its focus ring) in view, scrolling only when it isn't.
  useEffect(() => {
    const el = box.current;
    const card = cards.current[i];
    if (!el || !card) return;
    const top = card.offsetTop - 16;
    const bottom = card.offsetTop + card.offsetHeight + 16;
    if (top < el.scrollTop) el.scrollTop = Math.max(0, top);
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [i, n]);
  const ai = q.data?.source === "ai";
  const src = factsSourceKey(q.data?.source ?? null);
  return (
    <Shell
      testId="tv-facts-panel"
      heading={`✦ ${t("trivia.facts_title", { title })}`}
      badge={ai ? <span data-testid="tv-facts-ai" className="ml-6 shrink-0 rounded-full bg-accent px-5 py-1 text-[24px] font-bold text-on-accent">{t("trivia.ai_badge")}</span> : null}
      footer={
        <>
          <span>{ai ? t("trivia.ai_note") : src ? t(src) : ""}</span>
          <span className="ml-8 shrink-0">{n > 0 ? `${t("trivia.counter", { i: i + 1, n })} · ${t("trivia.tv_facts_hint")}` : `${t("common.close")}: ←`}</span>
        </>
      }
    >
      {q.isError ? (
        <Failed />
      ) : q.isPending ? (
        <Loading label="trivia.facts_loading" />
      ) : n === 0 ? (
        <Empty text={t("trivia.facts_empty")} />
      ) : (
        <div ref={box} className="relative -mx-3 mt-5 min-h-0 flex-1 overflow-hidden px-3 pt-3">
          {items.map((f, j) => {
            const hidden = isFactHidden(f, j, revealed);
            return (
              <div
                key={j}
                ref={(el) => {
                  cards.current[j] = el;
                }}
                data-testid="tv-fact"
                data-kind={f.kind}
                data-spoiler={f.spoiler ? (hidden ? "hidden" : "shown") : undefined}
                className={`tv-focus relative mb-5 overflow-hidden rounded-card bg-surface-2 px-8 py-6 ${j === i ? "is-focused" : ""}`}
              >
                {(f.kind === "blooper" || f.spoiler) && (
                  <div className="mb-3 flex">
                    {f.kind === "blooper" && <span className="mr-3 rounded-full bg-accent/20 px-4 text-[20px] font-bold uppercase leading-[34px] text-accent">{t("trivia.blooper")}</span>}
                    {f.spoiler && <span className="rounded-full bg-danger/20 px-4 text-[20px] font-bold uppercase leading-[34px] text-danger">{t("trivia.spoiler")}</span>}
                  </div>
                )}
                {/* Spoilers: a static blur under a solid label (no animated filters on old TV engines). */}
                <p className={`text-[28px] leading-[1.45] ${hidden ? "tv-spoiler-text line-clamp-2 select-none" : ""}`}>{f.text}</p>
                {hidden && (
                  <div className="absolute bottom-0 left-0 right-0 top-0 flex items-center justify-center bg-surface-2/70">
                    <span className="rounded-full bg-surface px-6 py-2 text-[24px] font-semibold">
                      {t("trivia.show_spoiler")}
                      {j === i ? " · OK" : ""}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Shell>
  );
}

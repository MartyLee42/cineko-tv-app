// «Цитаты» / «Факты» on the title page: two buttons beside «Посоветовать»
// and the sheets they open. Quotes are prefetched with the page (none found →
// no button); facts load when the sheet opens.
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { MediaDetail } from "@martytv/contracts";
import {
  factsSourceKey,
  formatQuote,
  formatSpeaker,
  isFactHidden,
  Mascot,
  revealFact,
  showQuotesButton,
  Spinner,
  useConstructivism,
  useI18n,
  type MediaFacts,
  type MediaQuotes,
  type MessageKey,
} from "@martytv/ui";
import { Button, ErrorText } from "../components";
import { Sheet } from "../remote/SendToTv";
import { useCatalogLang } from "./queries";
import { useFacts, useQuotes } from "./trivia";

/** A chip of the title page's «Дополнительно» row (facts, quotes, recap, after credits, soundtrack). */
export const EXTRA_CHIP =
  "inline-flex min-h-[40px] shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full border border-border bg-surface px-3.5 text-sm font-semibold text-text transition hover:border-accent";
const BTN = EXTRA_CHIP;

export function TriviaButtons({ m }: { m: Pick<MediaDetail, "id" | "title"> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<"quotes" | "facts" | null>(null);
  const quotes = useQuotes(m.id);
  const facts = useFacts(m.id, open === "facts");
  const close = () => setOpen(null);
  return (
    <>
      {showQuotesButton(quotes) && (
        <button type="button" data-testid="quotes-button" onClick={() => setOpen("quotes")} className={BTN}>
          <span aria-hidden className="text-lg leading-none">❝</span>
          {t("trivia.quotes")}
        </button>
      )}
      <button type="button" data-testid="facts-button" onClick={() => setOpen("facts")} className={BTN}>
        <span aria-hidden className="text-base leading-none">✦</span>
        {t("trivia.facts")}
      </button>
      {open === "quotes" && createPortal(<QuotesSheet title={m.title} q={quotes} onClose={close} />, document.body)}
      {open === "facts" && createPortal(<FactsSheet title={m.title} q={facts} onClose={close} />, document.body)}
    </>
  );
}

interface Q<T> {
  data?: T;
  isPending: boolean;
  error: unknown;
  isFetching: boolean;
  refetch: () => unknown;
}

function Loading({ label }: { label: MessageKey }) {
  const { t } = useI18n();
  const cv = useConstructivism();
  return (
    <div data-testid="trivia-loading" className="flex flex-col items-center gap-3 py-10 text-center">
      {cv ? <Spinner size={36} /> : <Mascot size={96} mood="thinking" animated />}
      <p className="font-semibold">{t(label)}</p>
      <p className="text-sm text-muted">{t("trivia.slow_hint")}</p>
    </div>
  );
}

/** Loading / error-with-retry / empty around the sheet's content. */
function States<T extends { items: unknown[] }>({ q, loading, empty, children }: { q: Q<T>; loading: MessageKey; empty: MessageKey; children: (d: T) => ReactNode }) {
  const { t } = useI18n();
  if (q.isPending && !q.error) return <Loading label={loading} />;
  if (q.error || !q.data) {
    return (
      <div className="space-y-3 py-4" data-testid="trivia-error">
        <ErrorText error={q.error} />
        <Button variant="secondary" busy={q.isFetching} onClick={() => void q.refetch()}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }
  if (q.data.items.length === 0) {
    return (
      <p data-testid="trivia-empty" className="rounded-xl bg-surface-2 px-3 py-6 text-center text-sm text-muted">
        {t(empty)}
      </p>
    );
  }
  return <>{children(q.data)}</>;
}

function Source({ label, url }: { label: string; url: string | null }) {
  return (
    <p className="pt-3 text-xs text-muted">
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted underline-offset-2 hover:text-text">
          {label}
        </a>
      ) : (
        label
      )}
    </p>
  );
}

function QuotesSheet({ title, q, onClose }: { title: string; q: Q<MediaQuotes>; onClose: () => void }) {
  const { t } = useI18n();
  const lang = useCatalogLang();
  return (
    <Sheet title={t("trivia.quotes")} subtitle={title} onClose={onClose} wide testId="quotes-sheet">
      <States q={q} loading="trivia.quotes_loading" empty="trivia.quotes_empty">
        {(d) => (
          <div className="space-y-3 pt-1">
            {d.lang !== lang && <p className="text-sm text-muted">{t(`trivia.other_lang_${d.lang}` as MessageKey)}</p>}
            <ul className="space-y-3">
              {d.items.map((x, i) => {
                const who = formatSpeaker(x.speaker);
                return (
                  <li key={i} data-testid="quote" className="rounded-2xl bg-surface-2 px-4 py-4 sm:px-5">
                    <figure>
                      <blockquote lang={d.lang} className="text-lg font-semibold leading-snug sm:text-xl">
                        {formatQuote(x.text, d.lang)}
                      </blockquote>
                      {who && <figcaption className="mt-2 text-sm text-muted">{who}</figcaption>}
                    </figure>
                  </li>
                );
              })}
            </ul>
            {d.source === "wikiquote" && <Source label={t("trivia.source.wikiquote")} url={d.source_url} />}
          </div>
        )}
      </States>
    </Sheet>
  );
}

function FactsSheet({ title, q, onClose }: { title: string; q: Q<MediaFacts>; onClose: () => void }) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());
  const ai = q.data?.source === "ai";
  const src = factsSourceKey(q.data?.source ?? null);
  return (
    <Sheet
      title={t("trivia.facts")}
      subtitle={
        <span className="flex items-center gap-2">
          <span className="truncate">{title}</span>
          {ai && (
            <span data-testid="facts-ai" className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs font-bold text-on-accent">
              {t("trivia.ai_badge")}
            </span>
          )}
        </span>
      }
      onClose={onClose}
      wide
      testId="facts-sheet"
    >
      <States q={q} loading="trivia.facts_loading" empty="trivia.facts_empty">
        {(d) => (
          <div className="space-y-3 pt-1">
            {ai && <p className="rounded-xl bg-accent/10 px-3 py-2 text-sm text-text/85">{t("trivia.ai_note")}</p>}
            <ul className="space-y-3">
              {d.items.map((f, i) => {
                const hidden = isFactHidden(f, i, revealed);
                return (
                  <li key={i} data-testid="fact" data-kind={f.kind} data-spoiler={f.spoiler ? (hidden ? "hidden" : "shown") : undefined} className="relative overflow-hidden rounded-2xl bg-surface-2 px-4 py-3.5 sm:px-5">
                    {(f.kind === "blooper" || f.spoiler) && (
                      <div className="mb-1.5 flex gap-1.5">
                        {f.kind === "blooper" && <span className="rounded-full bg-text/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-text">{t("trivia.blooper")}</span>}
                        {f.spoiler && <span className="rounded-full bg-danger/15 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-danger">{t("trivia.spoiler")}</span>}
                      </div>
                    )}
                    <p aria-hidden={hidden} className={`text-[15px] leading-relaxed ${hidden ? "pointer-events-none line-clamp-2 select-none blur-[6px]" : ""}`}>
                      {f.text}
                    </p>
                    {hidden && (
                      <div className="absolute inset-0 flex items-center justify-center bg-surface-2/40">
                        <button
                          type="button"
                          data-testid="show-spoiler"
                          onClick={() => setRevealed((r) => revealFact(r, i))}
                          className="min-h-[40px] rounded-full border border-border bg-surface px-4 text-sm font-semibold shadow hover:border-accent"
                        >
                          {t("trivia.show_spoiler")}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {!ai && src && <Source label={t(src)} url={d.source_url} />}
          </div>
        )}
      </States>
    </Sheet>
  );
}

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useI18n } from "@martytv/ui";
import { SearchIcon, CloseIcon } from "../icons";
import { CatalogPage, InfinitePosterGrid, Tabs } from "../catalog/components";
import { useSearch } from "../catalog/queries";
import type { ListKind } from "../catalog/filters";
import { ASK_MAX } from "../foryou/ask";
import { SparkIcon } from "../foryou/AskPage";
import { AskAiSuggestion, useAiSearch } from "../search/AiSearch";

const KINDS: ListKind[] = ["all", "movie", "series"];

export function SearchPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const ai = params.get("ai") === "1";
  const q = (params.get("q") ?? "").trim().slice(0, ai ? ASK_MAX : 100);
  const kindParam = params.get("kind");
  const kind: ListKind = KINDS.includes(kindParam as ListKind) ? (kindParam as ListKind) : "all";
  const [text, setText] = useState(params.get("q") ?? "");
  // Follow external URL changes (back/forward, nav link) without fighting typing.
  const [prevQ, setPrevQ] = useState(q);
  if (q !== prevQ) {
    setPrevQ(q);
    if (q !== text.trim()) setText(q);
  }

  // Debounce typing into the URL; the query reads q from the URL.
  useEffect(() => {
    const id = setTimeout(() => {
      if (text.trim() === q) return;
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (text.trim()) next.set("q", text.trim());
          else next.delete("q");
          return next;
        },
        { replace: true },
      );
    }, 300);
    return () => clearTimeout(id);
  }, [text, q, setParams]);

  const setKind = (k: ListKind) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (k === "all") next.delete("kind");
        else next.set("kind", k);
        return next;
      },
      { replace: true },
    );

  // AI mode doesn't run the title search: the words are a description.
  const query = useSearch(ai ? "" : q, kind);
  const input = useRef<HTMLInputElement>(null);
  // AI mode is «Спросить ИИ» in the search box: the same ask, answer and refinement (search/AiSearch.tsx).
  const aiSearch = useAiSearch({
    kind: kind === "all" ? "any" : kind,
    onPrompt: setText,
    onKind: (k) => setKind(k === "any" ? "all" : k),
    restore: ai ? q : "",
  });
  const askAi = (prompt = text) => {
    if (!prompt.trim()) {
      input.current?.focus();
      return;
    }
    input.current?.blur(); // closes the phone keyboard so the answer is visible
    aiSearch.send(prompt);
  };
  const setAi = (on: boolean) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (on) next.set("ai", "1");
        else next.delete("ai");
        return next;
      },
      { replace: true },
    );
    if (on && text.trim()) askAi();
    else input.current?.focus();
  };

  return (
    <CatalogPage>
      <h1 className="sr-only">{t("catalog.search")}</h1>
      <div className="sticky top-14 z-[5] -mx-4 space-y-3 bg-bg/90 px-4 pb-3 pt-1 backdrop-blur">
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (ai) askAi();
          }}
          className="relative"
        >
          {ai ? (
            <SparkIcon className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-xl text-accent" />
          ) : (
            <SearchIcon className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-xl text-muted" />
          )}
          <input
            ref={input}
            type="search"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={ai ? t("catalog.ai.placeholder") : t("catalog.search_placeholder")}
            aria-label={ai ? t("catalog.ai.placeholder") : t("catalog.search_placeholder")}
            maxLength={ai ? ASK_MAX : 100}
            enterKeyHint={ai ? "send" : "search"}
            data-testid="search-input"
            className={`h-14 w-full rounded-2xl border bg-surface pl-12 text-lg ${ai ? "border-accent/60 pr-24" : "border-border pr-12"} text-text outline-none placeholder:text-muted focus:border-accent [&::-webkit-search-cancel-button]:hidden`}
          />
          {text && (
            <button
              type="button"
              aria-label={t("common.cancel")}
              onClick={() => setText("")}
              className={`absolute top-1/2 ${ai ? "right-12" : "right-1.5"} flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-xl text-muted hover:text-text`}
            >
              <CloseIcon />
            </button>
          )}
          {ai && (
            <button
              type="submit"
              aria-label={t("catalog.ai.send")}
              disabled={aiSearch.busy}
              data-testid="search-ai-send"
              className="absolute right-1.5 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-xl bg-accent text-lg font-bold text-on-accent disabled:opacity-50"
            >
              ↑
            </button>
          )}
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            label={t("catalog.search")}
            value={kind}
            onChange={setKind}
            options={KINDS.map((k) => ({
              value: k,
              label: k === "all" ? t("catalog.kind.all") : k === "movie" ? t("catalog.movies") : t("catalog.series"),
            }))}
          />
          {aiSearch.available && (
            <button
              type="button"
              aria-pressed={ai}
              onClick={() => setAi(!ai)}
              data-testid="search-ai-toggle"
              className={`inline-flex min-h-[48px] items-center gap-1.5 rounded-xl border px-4 text-sm font-semibold transition ${
                ai ? "border-accent bg-accent text-on-accent" : "border-accent/50 text-accent hover:bg-accent/10"
              }`}
            >
              <SparkIcon /> {t("catalog.ai.mode")}
            </button>
          )}
          {/* Title search always shows watched titles (✓); these steer AI picks only, as on /ask. */}
          {ai && aiSearch.controls}
        </div>
      </div>

      <div className="mt-4">
        {ai ? (
          aiSearch.view
        ) : q ? (
          <>
            {aiSearch.available && (
              <AskAiSuggestion
                q={q}
                onAsk={() => {
                  setAi(true);
                }}
              />
            )}
            <InfinitePosterGrid
            query={query}
            empty={t("catalog.search_empty", { q })}
            />
          </>
        ) : (
          <div className="flex flex-col items-center gap-3 py-20 text-center text-muted">
            <SearchIcon className="text-5xl opacity-40" />
            <p>{t("catalog.search_hint")}</p>
          </div>
        )}
      </div>
    </CatalogPage>
  );
}

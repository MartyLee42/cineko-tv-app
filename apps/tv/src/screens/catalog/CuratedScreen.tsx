import { useMemo, useState } from "react";
import type { MediaSummary } from "@martytv/contracts";
import { curatedGroupTitle, curatedPercent, curatedProgressLabel, useI18n } from "@martytv/ui";
import type { RouteMemory } from "../../catalog/nav";
import { ProgressBar } from "../../components/Poster";
import { useDesign } from "../../design/context";
import { ScreenTitle } from "../../design/grid";
import { useCurated } from "../../foryou/queries";
import { curatedCards, curatedNote } from "../../foryou/curated";
import { TitleGrid } from "./ExploreScreen";

const HEADER_H = 330;

/** «Подборки»: a curated list (book, director's list, poll) with progress and the focused film's note. */
export function CuratedScreen({ id, title, mem, onOpen }: { id: string; title?: string; mem: RouteMemory; onOpen: (item: MediaSummary, from?: string) => void }) {
  const { t } = useI18n();
  const design = useDesign();
  const q = useCurated(id);
  const c = q.data;
  const name = c?.title ?? title ?? "";
  const cards = useMemo(() => curatedCards(c?.items ?? []), [c]);
  const [focused, setFocused] = useState(() => mem.get<number>("idx") ?? 0);
  const cur = cards.notes[Math.min(focused, cards.notes.length - 1)];
  const note = curatedNote(cur, (n) => t("curated.rank", { n }));
  const meta = c ? [c.author, c.source].filter(Boolean).join(" · ") : "";
  return (
    <TitleGrid
      testId="curated"
      scope="xq"
      mem={mem}
      from={name}
      onOpen={onOpen}
      onFocusIndex={setFocused}
      pinHeader
      items={cards.media}
      pending={q.isPending}
      error={q.isError ? q.error : null}
      onRetry={() => void q.refetch()}
      headerHeight={HEADER_H}
      header={
        <div className="pt-8" style={{ height: HEADER_H }}>
          <span className={`inline-block px-4 py-1 text-[20px] font-bold ${design === "terminal" ? "t-label bg-accent text-on-accent" : "rounded-full bg-accent text-on-accent"}`}>
            {t("curated.title")}
            {c ? ` · ${curatedGroupTitle(c.group, t, c.group)}` : ""}
          </span>
          <div data-testid="curated-title" className="mt-3 max-w-[1500px] truncate">
            <ScreenTitle design={design}>{name}</ScreenTitle>
          </div>
          {meta && <p className="mt-1 max-w-[1500px] truncate text-[24px] text-text/75">{meta}</p>}
          {c && (
            <div className="mt-3 flex items-center text-[24px]">
              <span className="relative inline-block h-2 w-[320px] overflow-hidden rounded-full">
                <ProgressBar fraction={curatedPercent(c.watched, c.count) / 100} />
              </span>
              <span data-testid="curated-progress" className="ml-5 text-text">
                {curatedProgressLabel(c.watched, c.count, t)}
              </span>
              {cards.missing > 0 && (
                <span data-testid="curated-missing" className="ml-5 text-muted">
                  · {t("curated.missing")}: {cards.missing}
                </span>
              )}
            </div>
          )}
          {q.isError && <p className="mt-3 text-[26px] text-muted">{t("curated.not_found")}</p>}
          <p data-testid="curated-note" className="mt-3 h-[36px] max-w-[1500px] truncate text-[26px] text-accent">
            {note}
          </p>
        </div>
      }
    />
  );
}

// An actor's (or director's) page: photo, dates, a few lines of bio and
// every film and series they were in (most popular first). OK opens Details.
import { useMemo } from "react";
import type { MediaSummary } from "@martytv/contracts";
import { formatDate, imageUrl, placeholderColor } from "@martytv/media-types";
import { useI18n } from "@martytv/ui";
import type { RouteMemory } from "../../catalog/nav";
import { useCatalogConfig, usePerson } from "../../catalog/queries";
import { Img, legacyColor } from "../../components/Img";
import { useDesign } from "../../design/context";
import { ScreenTitle } from "../../design/grid";
import { TitleGrid } from "./ExploreScreen";

const HEADER = 330;

export function PersonScreen({
  tmdbId,
  name,
  mem,
  onOpen,
}: {
  tmdbId: number;
  name: string;
  mem: RouteMemory;
  onOpen: (item: MediaSummary, from?: string) => void;
}) {
  const { t, locale } = useI18n();
  const design = useDesign();
  const cfg = useCatalogConfig();
  const q = usePerson(tmdbId);
  const p = q.data;
  const title = p?.name ?? name;
  const items = useMemo(() => p?.credits.map((c) => c.media) ?? [], [p]);
  const facts = p
    ? [
        p.birthday && t("catalog.person.born", { date: formatDate(p.birthday, locale) ?? p.birthday }),
        p.deathday && t("catalog.person.died", { date: formatDate(p.deathday, locale) ?? p.deathday }),
        p.place_of_birth,
      ].filter(Boolean)
    : [];
  return (
    <TitleGrid
      testId="person"
      scope="pp"
      mem={mem}
      from={title}
      onOpen={onOpen}
      items={items}
      pending={q.isPending}
      error={q.isError ? q.error : null}
      onRetry={() => void q.refetch()}
      headerHeight={HEADER}
      header={
        <div className="flex gap-8 pt-8" style={{ height: HEADER }}>
          <div
            className={`relative shrink-0 overflow-hidden ${design === "terminal" ? "" : "rounded-card"}`}
            style={{ width: 170, height: 255, background: legacyColor(placeholderColor(title)) }}
          >
            <span className="absolute left-0 top-0 flex h-full w-full items-center justify-center text-7xl font-bold text-text/60">{title.trim()[0] ?? "?"}</span>
            <Img src={imageUrl(cfg.data, p?.profile_path, "h632")} className="absolute left-0 top-0 h-full w-full object-cover" />
          </div>
          <div className="min-w-0 flex-1">
            <ScreenTitle design={design}>{title}</ScreenTitle>
            {facts.length > 0 && <p className="mt-3 text-[24px] text-muted">{facts.join(" · ")}</p>}
            {p?.biography && <p className="mt-3 line-clamp-3 max-w-[1350px] text-[24px] leading-snug text-text/75">{p.biography}</p>}
            {p && <p className="mt-3 text-[22px] text-muted">{t("catalog.person.filmography")}: {items.length}</p>}
          </div>
        </div>
      }
    />
  );
}

// «Уточнить поиск»: edit the search text (pre-filled with the Russian title +
// year, quick chips for the original title / no year / "S01") and allow
// uncertain matches. Applied by the release list (remembered per title).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { unwrap } from "@martytv/contracts";
import { useI18n, type MessageKey } from "@martytv/ui";
import { api } from "../api";
import { Button, Input } from "../components";
import { useCatalogLang, useMedia } from "../catalog/queries";
import { SearchIcon } from "../icons";
import { Sheet } from "../remote/SendToTv";
import { cleanQuery, defaultQuery, queryChips, validQuery, type ChipKey, type Refine, type RefineTitle } from "./refine";

/** Title data for the pre-fill: the Russian title even when the UI is in English. */
export function useRefineTitle(mediaId: string, seasonNumber: number | undefined): RefineTitle | null {
  const lang = useCatalogLang();
  const m = useMedia(mediaId).data;
  const ru = useQuery({
    queryKey: ["media", mediaId, "ru-title"],
    queryFn: () => unwrap(api.GET("/media/{id}", { params: { path: { id: mediaId }, query: { lang: "ru" } } })),
    enabled: !!m && lang !== "ru",
    staleTime: 60 * 60_000,
    retry: false,
  });
  if (!m) return null;
  return {
    title: (lang === "ru" ? m.title : ru.data?.title) || m.title,
    original_title: m.original_title,
    year: m.year,
    kind: m.kind,
    season_number: seasonNumber ?? null,
  };
}

const CHIP_LABEL: Record<ChipKey, MessageKey> = {
  original: "player.refine.chip_original",
  local: "player.refine.chip_local",
  no_year: "player.refine.chip_no_year",
  year: "player.refine.chip_year",
  season: "player.refine.chip_season",
};

export function RefineSheet({
  title,
  value,
  onApply,
  onClose,
}: {
  title: RefineTitle | null;
  value: Refine;
  onApply: (r: Refine) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState(() => value.q ?? (title ? defaultQuery(title) : ""));
  const [loose, setLoose] = useState(value.loose);
  const chips = title ? queryChips(title, q) : [];
  const ok = validQuery(q);
  const submit = () => {
    if (!ok) return;
    onApply({ q: cleanQuery(q), loose });
  };

  return (
    <Sheet title={t("player.refine.title")} subtitle={t("player.refine.subtitle")} onClose={onClose} testId="refine-sheet">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="block space-y-1.5">
          <span className="text-sm text-muted">{t("player.refine.query")}</span>
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={100}
            enterKeyHint="search"
            autoComplete="off"
            spellCheck={false}
            data-autofocus
            data-testid="refine-query"
          />
          {!ok && q.trim().length > 0 && <span className="block text-xs text-danger">{t("player.refine.too_short")}</span>}
        </label>
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5" data-testid="refine-chips">
            {chips.map((c) => (
              <button
                key={c.key}
                type="button"
                data-chip={c.key}
                onClick={() => setQ(c.query)}
                title={c.query}
                className="min-h-[36px] rounded-full border border-border bg-bg/40 px-3 text-sm font-semibold text-text/85 transition hover:border-accent"
              >
                {t(CHIP_LABEL[c.key], { season: String(title?.season_number ?? 1).padStart(2, "0") })}
              </button>
            ))}
          </div>
        )}
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-surface-2/60 p-3">
          <input
            type="checkbox"
            checked={loose}
            onChange={(e) => setLoose(e.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--mt-accent))]"
            data-testid="refine-loose"
          />
          <span>
            <span className="block text-sm font-semibold">{t("player.refine.loose")}</span>
            <span className="block text-xs text-muted">{t("player.refine.loose_hint")}</span>
          </span>
        </label>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {(value.q || value.loose) && (
            <Button type="button" variant="ghost" onClick={() => onApply({ q: null, loose: false })} data-testid="refine-reset">
              {t("player.refine.reset")}
            </Button>
          )}
          <Button type="submit" disabled={!ok} data-testid="refine-search">
            <SearchIcon />
            {t("player.refine.search")}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

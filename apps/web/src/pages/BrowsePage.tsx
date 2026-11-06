import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import type { MediaKind } from "@martytv/contracts";
import { useI18n, type MessageKey } from "@martytv/ui";
import { Button, Select } from "../components";
import { CloseIcon, FilterIcon } from "../icons";
import { CatalogPage, InfinitePosterGrid, Tabs } from "../catalog/components";
import {
  activeFilterCount,
  browseToParams,
  EMPTY_FILTERS,
  FILTER_LANGUAGES,
  listTitleKey,
  parseBrowse,
  RATING_STEPS,
  RUNTIME_BUCKETS,
  SORT_KEYS,
  toDiscoverQuery,
  type BrowseState,
  type DiscoverFilters,
  type SortKey,
} from "../catalog/filters";
import { useCatalogList, useDiscover, useGenres } from "../catalog/queries";
import { HideWatchedToggle } from "../watch/components";

type Discover = Extract<BrowseState, { mode: "discover" }>;
type ListState = Extract<BrowseState, { mode: "list" }>;

const gridWithSidebar = "grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 sm:gap-x-4 lg:grid-cols-4 xl:grid-cols-5";

export function BrowsePage() {
  const [params, setParams] = useSearchParams();
  const state = parseBrowse(params);
  const setState = (next: BrowseState) => setParams(browseToParams(next), { replace: true });

  return (
    <CatalogPage>
      {state.mode === "list" ? <ListView state={state} /> : <DiscoverView state={state} setState={setState} />}
    </CatalogPage>
  );
}

function ListView({ state }: { state: ListState }) {
  const { t } = useI18n();
  const query = useCatalogList(state.list, state.kind);
  const key = listTitleKey(state.list, state.kind);
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold sm:text-3xl">{key ? t(key as MessageKey) : t("catalog.browse")}</h1>
        <HideWatchedToggle className="ml-auto" />
        <Link
          to={`/browse?kind=${state.kind === "series" ? "series" : "movie"}`}
          className="flex min-h-[44px] items-center gap-2 rounded-xl bg-surface-2 px-4 text-sm font-semibold hover:bg-border"
        >
          <FilterIcon /> {t("catalog.filters")}
        </Link>
      </div>
      <InfinitePosterGrid query={query} empty={t("catalog.no_results")} />
    </div>
  );
}

function DiscoverView({ state, setState }: { state: Discover; setState: (s: BrowseState) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const query = useDiscover(toDiscoverQuery(state));
  const active = activeFilterCount(state);
  const total = query.data?.pages[0]?.total_results;

  const setKind = (kind: MediaKind) =>
    // Genre ids differ between movies and series; runtime is movie-only.
    setState({ ...state, kind, genres: [], runtime: kind === "movie" ? state.runtime : null });
  const patch = (p: Partial<DiscoverFilters>) => setState({ ...state, ...p });

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold sm:text-3xl">{t("catalog.browse")}</h1>
        <Tabs
          label={t("catalog.browse")}
          value={state.kind}
          onChange={setKind}
          options={[
            { value: "movie", label: t("catalog.movies") },
            { value: "series", label: t("catalog.series") },
          ]}
        />
      </div>

      <div className="mb-4 flex items-center gap-2 lg:hidden">
        <Button variant="secondary" aria-expanded={open} aria-controls="browse-filters" onClick={() => setOpen((o) => !o)}>
          <FilterIcon /> {t("catalog.filters")}
          {active > 0 && (
            <span className="rounded-full bg-accent px-1.5 text-xs font-bold leading-5 text-on-accent">{active}</span>
          )}
        </Button>
        <HideWatchedToggle className="ml-auto" />
        <SortSelect value={state.sort} onChange={(sort) => patch({ sort })} className="w-auto" />
      </div>

      <div className="lg:grid lg:grid-cols-[15rem_1fr] lg:gap-8">
        <aside
          id="browse-filters"
          className={`${open ? "block" : "hidden"} mb-6 rounded-2xl border border-border bg-surface p-4 lg:sticky lg:top-20 lg:mb-0 lg:block lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto lg:overscroll-contain`}
        >
          <Filters state={state} patch={patch} onClose={() => setOpen(false)} />
        </aside>

        <div className="min-w-0">
          <div className="mb-3 flex items-center gap-3">
            {total != null && (
              <p className="text-sm text-muted" aria-live="polite">
                {t("catalog.results_count", { n: total.toLocaleString() })}
              </p>
            )}
            <HideWatchedToggle className="ml-auto hidden lg:inline-flex" />
          </div>
          <InfinitePosterGrid
            query={query}
            className={gridWithSidebar}
            empty={
              <div className="space-y-4">
                <p>{t("catalog.no_results")}</p>
                {active > 0 && (
                  <Button variant="secondary" onClick={() => setState({ mode: "discover", kind: state.kind, ...EMPTY_FILTERS })}>
                    {t("catalog.filter.reset")}
                  </Button>
                )}
              </div>
            }
          />
        </div>
      </div>
    </div>
  );
}

function SortSelect({ value, onChange, className = "" }: { value: SortKey; onChange: (v: SortKey) => void; className?: string }) {
  const { t } = useI18n();
  return (
    <Select aria-label={t("catalog.sort")} value={value} onChange={(e) => onChange(e.target.value as SortKey)} className={className}>
      {SORT_KEYS.map((s) => (
        <option key={s} value={s}>
          {t(`catalog.sort.${s}` as MessageKey)}
        </option>
      ))}
    </Select>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-2 border-t border-border pt-4 first:border-0 first:pt-0">
      <legend className="float-left mb-2 w-full text-xs font-semibold uppercase tracking-wider text-muted">{label}</legend>
      <div className="clear-both">{children}</div>
    </fieldset>
  );
}

const thisYear = new Date().getFullYear();
const YEARS = Array.from({ length: thisYear + 2 - 1920 }, (_, i) => thisYear + 1 - i);

function Filters({ state, patch, onClose }: { state: Discover; patch: (p: Partial<DiscoverFilters>) => void; onClose: () => void }) {
  const { t } = useI18n();
  const genres = useGenres(state.kind);
  const toggleGenre = (id: number) =>
    patch({ genres: state.genres.includes(id) ? state.genres.filter((g) => g !== id) : [...state.genres, id].sort((a, b) => a - b) });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">{t("catalog.filters")}</h2>
        <div className="flex items-center gap-1">
          {activeFilterCount(state) > 0 && (
            <button
              type="button"
              className="min-h-[36px] rounded-lg px-2 text-sm text-muted hover:text-text"
              onClick={() => patch({ ...EMPTY_FILTERS, sort: state.sort })}
            >
              {t("catalog.filter.reset")}
            </button>
          )}
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text lg:hidden"
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      <div className="hidden lg:block">
        <Group label={t("catalog.sort")}>
          <SortSelect value={state.sort} onChange={(sort) => patch({ sort })} />
        </Group>
      </div>

      <Group label={t("catalog.filter.genre")}>
        <div className="flex flex-wrap gap-1.5">
          {genres.data?.map((g) => {
            const on = state.genres.includes(g.id);
            return (
              <button
                key={g.id}
                type="button"
                aria-pressed={on}
                data-testid="genre-chip"
                onClick={() => toggleGenre(g.id)}
                className={`min-h-[36px] rounded-full border px-3 text-sm transition ${
                  on ? "border-accent bg-accent/15 text-accent-strong" : "border-border text-text/85 hover:border-muted"
                }`}
              >
                {g.name}
              </button>
            );
          }) ?? Array.from({ length: 10 }, (_, i) => <span key={i} className="h-9 w-20 animate-pulse rounded-full bg-surface-2" />)}
        </div>
      </Group>

      <Group label={t("catalog.filter.year")}>
        <div className="grid grid-cols-2 gap-2">
          <YearSelect label={t("catalog.filter.year_from")} value={state.yearFrom} onChange={(yearFrom) => patch({ yearFrom })} />
          <YearSelect label={t("catalog.filter.year_to")} value={state.yearTo} onChange={(yearTo) => patch({ yearTo })} />
        </div>
      </Group>

      {state.kind === "movie" && (
        <Group label={t("catalog.filter.runtime")}>
          <Chips
            value={state.runtime}
            onChange={(runtime) => patch({ runtime })}
            options={RUNTIME_BUCKETS.map((b) => ({ value: b, label: t(`catalog.filter.runtime_${b}` as MessageKey) }))}
          />
        </Group>
      )}

      <Group label={t("catalog.filter.rating")}>
        <Chips
          value={state.ratingMin}
          onChange={(ratingMin) => patch({ ratingMin })}
          options={RATING_STEPS.map((r) => ({ value: r, label: `★ ${r}+` }))}
        />
      </Group>

      <Group label={t("catalog.filter.language")}>
        <Select
          aria-label={t("catalog.filter.language")}
          value={state.language ?? ""}
          onChange={(e) => patch({ language: e.target.value || null })}
        >
          <option value="">{t("catalog.filter.any")}</option>
          {FILTER_LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {t(`catalog.lang.${l}` as MessageKey)}
            </option>
          ))}
        </Select>
      </Group>

      <Button className="w-full lg:hidden" onClick={onClose}>
        {t("catalog.filter.close")}
      </Button>
    </div>
  );
}

function YearSelect({ label, value, onChange }: { label: string; value: number | null; onChange: (v: number | null) => void }) {
  const { t } = useI18n();
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted">{label}</span>
      <Select value={value ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">{t("catalog.filter.any")}</option>
        {YEARS.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </Select>
    </label>
  );
}

/** Single-choice chip group; tapping the active chip clears it. */
function Chips<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T | null;
  options: { value: T; label: string }[];
  onChange: (v: T | null) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? null : o.value)}
            className={`min-h-[36px] rounded-full border px-3 text-sm transition ${
              on ? "border-accent bg-accent/15 text-accent-strong" : "border-border text-text/85 hover:border-muted"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

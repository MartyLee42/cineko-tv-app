import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { episodeCode, imageUrl, placeholderColor } from "@martytv/media-types";
import { monthLabel, Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { CatalogError, Img, Poster } from "../catalog/components";
import { useCatalogConfig } from "../catalog/queries";
import { ChevronLeft, ChevronRight } from "../icons";
import { NoProfile, RatingChip } from "../pages/HistoryPage";
import { useActiveProfile } from "../watch/ActiveProfile";
import { calendarWeeks, currentMonth, parseMonth, shiftMonth } from "./logic";
import { useDiary, type Diary } from "./queries";

type Day = Diary["days"][number];
type Entry = Day["entries"][number];

/** «Дневник»: a month calendar of what the profile watched and rated, plus the month's stats. */
export function DiaryPage() {
  const { t } = useI18n();
  const { profile } = useActiveProfile();
  const [params, setParams] = useSearchParams();
  const month = parseMonth(params.get("month")) ?? currentMonth();
  const q = useDiary(month);
  const [picked, setPicked] = useState<string | null>(null);
  const byDate = useMemo(() => new Map((q.data?.days ?? []).map((d) => [d.date, d])), [q.data]);
  const weeks = calendarWeeks(month);
  const now = currentMonth();
  const go = (m: string) => {
    setPicked(null);
    setParams(m === now ? {} : { month: m }, { replace: true });
  };
  // Default selection: the latest day with entries.
  const days = q.data?.days ?? [];
  const selected = (picked && byDate.get(picked)) || days[days.length - 1] || null;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to="/history" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
            <ChevronLeft /> {t("nav.history")}
          </Link>
          <h1 className="mt-1 text-2xl font-bold sm:text-3xl">{t("fy.diary.title")}</h1>
          <p className="text-sm text-muted">{t("fy.diary.subtitle")}</p>
        </div>
        <Link to="/taste" className="flex min-h-[40px] items-center gap-1.5 rounded-xl bg-accent/15 px-3.5 text-sm font-semibold text-text hover:bg-accent/25">
          🧬 {t("nav.taste")}
        </Link>
      </header>
      {!profile ? (
        <NoProfile />
      ) : (
        <>
          <div className="flex items-center gap-2">
            <button type="button" aria-label={t("fy.diary.prev")} data-testid="diary-prev" onClick={() => go(shiftMonth(month, -1))} className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-xl hover:bg-border">
              <ChevronLeft />
            </button>
            <h2 className="min-w-[10rem] flex-1 text-center text-lg font-bold sm:flex-none" data-testid="diary-month">
              {monthLabel(month, t)}
            </h2>
            <button type="button" aria-label={t("fy.diary.next")} data-testid="diary-next" disabled={month >= now} onClick={() => go(shiftMonth(month, 1))} className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-xl hover:bg-border disabled:opacity-40">
              <ChevronRight />
            </button>
            {month !== now && (
              <button type="button" onClick={() => go(now)} className="ml-auto min-h-[40px] rounded-xl px-3 text-sm font-semibold text-muted hover:text-text">
                {t("fy.diary.today")}
              </button>
            )}
          </div>
          {q.isPending ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : q.error ? (
            <CatalogError error={q.error} onRetry={() => q.refetch()} />
          ) : (
            <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
              <div className="space-y-4">
                <div className="rounded-2xl border border-border bg-surface p-2 sm:p-3" data-testid="diary-calendar">
                  <div className="mb-1 grid grid-cols-7 gap-1 text-center text-[11px] font-semibold uppercase text-muted">
                    {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                      <span key={d}>{t(`fy.weekday.${d}` as MessageKey)}</span>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-1">
                    {weeks.flat().map((c, i) =>
                      c.date ? (
                        <DayCell key={c.date} day={c.day!} entry={byDate.get(c.date) ?? null} on={selected?.date === c.date} onPick={() => setPicked(c.date)} />
                      ) : (
                        <span key={`pad-${i}`} />
                      ),
                    )}
                  </div>
                </div>
                {!days.length ? (
                  <p className="py-8 text-center text-muted" data-testid="diary-empty">
                    {t("fy.diary.empty")}
                  </p>
                ) : (
                  selected && <DayList day={selected} />
                )}
              </div>
              <Stats d={q.data} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DayCell({ day, entry, on, onPick }: { day: number; entry: Day | null; on: boolean; onPick: () => void }) {
  const { t } = useI18n();
  const { data: cfg } = useCatalogConfig();
  const first = entry?.entries[0];
  const n = entry?.entries.length ?? 0;
  if (!entry || !first) {
    return <span className="flex aspect-[2/3] items-start justify-start rounded-lg bg-bg/40 p-1 text-[11px] text-muted sm:text-xs">{day}</span>;
  }
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={on}
      aria-label={`${day}: ${entry.entries.map((e) => e.media.title).join(", ")}`}
      data-testid="diary-day"
      data-date={entry.date}
      className={`relative aspect-[2/3] overflow-hidden rounded-lg text-left ring-offset-2 ring-offset-surface transition hover:brightness-110 ${on ? "ring-2 ring-accent" : ""}`}
      style={{ background: placeholderColor(first.media.title) }}
    >
      <Img src={imageUrl(cfg, first.media.poster_path, "w185")} alt="" className="absolute inset-0 h-full w-full object-cover" fallback={null} />
      <span className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-black/60" aria-hidden />
      <span className="absolute left-1 top-0.5 text-[11px] font-bold text-white sm:text-xs">{day}</span>
      {n > 1 && <span className="absolute right-1 top-0.5 rounded-full bg-accent px-1 text-[10px] font-bold text-on-accent" title={t("fy.diary.day_items", { n })}>+{n - 1}</span>}
      {first.rating != null && <span className="absolute bottom-0.5 right-1 text-[10px] font-bold text-amber-300 sm:text-[11px]">★{first.rating}</span>}
    </button>
  );
}

function DayList({ day }: { day: Day }) {
  const { locale } = useI18n();
  const date = new Date(`${day.date}T00:00:00Z`).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  return (
    <section data-testid="diary-day-list">
      <h3 className="mb-2 text-sm font-semibold capitalize text-muted">{date}</h3>
      <ul className="space-y-2">
        {day.entries.map((e) => (
          <EntryRow key={`${e.media.id}-${e.at}`} e={e} />
        ))}
      </ul>
    </section>
  );
}

function EntryRow({ e }: { e: Entry }) {
  const { t } = useI18n();
  const { data: cfg } = useCatalogConfig();
  const eps = e.episodes.slice(0, 4).map((x) => episodeCode(x.season_number, x.episode_number));
  return (
    <li>
      <Link to={`/title/${e.media.id}`} className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-2.5 hover:border-muted">
        <div className="relative aspect-[2/3] w-11 shrink-0 overflow-hidden rounded-lg" style={{ background: placeholderColor(e.media.title) }}>
          <Img src={imageUrl(cfg, e.media.poster_path, "w185")} alt="" className="absolute inset-0 h-full w-full object-cover" fallback={null} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{e.media.title}</p>
          <p className="truncate text-xs text-muted">
            {[e.media.year, e.watched ? t("fy.diary.watched") : null, e.rewatch ? t("fy.diary.rewatch") : null, eps.length ? eps.join(", ") + (e.episodes.length > 4 ? "…" : "") : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        {e.rating != null && <RatingChip value={e.rating} />}
      </Link>
    </li>
  );
}

function Stats({ d }: { d: Diary }) {
  const { t } = useI18n();
  const s = d.stats;
  const tiles: [MessageKey, string | number][] = [
    ["fy.diary.movies", s.movies_watched],
    ["fy.diary.episodes", s.episodes_watched],
    ["fy.diary.hours", s.hours_watched],
    ["fy.diary.ratings", s.ratings_count],
    ["fy.diary.average", s.average_rating != null ? s.average_rating.toFixed(1) : "—"],
    ["fy.diary.rewatches", s.rewatches],
  ];
  return (
    <aside className="space-y-4" data-testid="diary-stats">
      <div className="grid grid-cols-3 gap-2">
        {tiles.map(([k, v]) => (
          <div key={k} className="rounded-2xl border border-border bg-surface p-3">
            <p className="text-xl font-extrabold tabular-nums sm:text-2xl">{v}</p>
            <p className="text-[11px] leading-tight text-muted">{t(k)}</p>
          </div>
        ))}
      </div>
      <CountList title={t("fy.diary.fav_genres")} items={s.favorite_genres} />
      <CountList title={t("fy.diary.fav_decades")} items={s.favorite_decades.map((x) => ({ ...x, name: x.name || t("fy.surprise.decade_label", { decade: x.key }) }))} />
      <CountList title={t("fy.diary.top_directors")} items={s.top_directors} />
      {!!s.top_rated.length && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-muted">{t("fy.diary.top_rated")}</h3>
          <div className="grid grid-cols-4 gap-2">
            {s.top_rated.slice(0, 8).map((x) => (
              <Link key={x.media.id} to={`/title/${x.media.id}`} className="relative block" title={x.media.title}>
                <Poster item={x.media} sizes="80px" />
                <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 text-[11px] font-bold text-amber-300">★{x.rating}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}

function CountList({ title, items }: { title: string; items: { key: string; name: string; count: number }[] }) {
  if (!items.length) return null;
  const max = Math.max(...items.map((i) => i.count));
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-muted">{title}</h3>
      <ul className="space-y-1.5">
        {items.slice(0, 5).map((i) => (
          <li key={i.key} className="text-sm">
            <div className="flex justify-between gap-2">
              <span className="truncate">{i.name}</span>
              <span className="tabular-nums text-muted">{i.count}</span>
            </div>
            <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent" style={{ width: `${(i.count / max) * 100}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

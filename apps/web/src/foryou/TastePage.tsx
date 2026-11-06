import { Link } from "react-router";
import { imageUrl, placeholderColor } from "@martytv/media-types";
import { Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { timeAgo } from "../components";
import { CatalogError, Img } from "../catalog/components";
import { useCatalogConfig } from "../catalog/queries";
import { ChevronLeft } from "../icons";
import { NoProfile } from "../pages/HistoryPage";
import { PreferencesPanel } from "../tastequiz/GenerateFromHistory";
import { useActiveProfile } from "../watch/ActiveProfile";
import { arcPath, divergingBar, histogramBars, percent, splitAffinities } from "./logic";
import { useTaste, type TasteDNA } from "./queries";

type Affinity = TasteDNA["genres"][number];
type Person = TasteDNA["directors"][number];

// Chart colours: magnitude = the accent (one hue); polarity = accent (love) vs a
// cool sky (not for you) around a neutral track; text stays in ink tokens.
const POS = "rgb(var(--mt-accent))";
const NEG = "#38bdf8";

/** «ДНК вкуса»: the profile's real taste, drawn with inline SVG (no chart deps). */
export function TastePage() {
  const { t, locale } = useI18n();
  const { profile } = useActiveProfile();
  const q = useTaste();
  const d = q.data;
  const empty = d && d.signals.ratings + d.signals.completed === 0;
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to="/history" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
            <ChevronLeft /> {t("nav.history")}
          </Link>
          <h1 className="mt-1 text-2xl font-bold sm:text-3xl">🧬 {t("fy.taste.title")}</h1>
          <p className="text-sm text-muted">
            {t("fy.taste.subtitle")}
            {d && ` · ${t("fy.taste.computed", { time: timeAgo(d.computed_at, locale) })}`}
          </p>
        </div>
        <Link to="/diary" className="flex min-h-[40px] items-center gap-1.5 rounded-xl bg-accent/15 px-3.5 text-sm font-semibold text-text hover:bg-accent/25">
          📅 {t("nav.diary")}
        </Link>
      </header>
      {!profile ? (
        <NoProfile />
      ) : q.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : q.error ? (
        <CatalogError error={q.error} onRetry={() => q.refetch()} />
      ) : !d ? null : empty ? (
        <div className="space-y-5">
          <p className="rounded-2xl border border-dashed border-border bg-surface px-6 py-12 text-center text-muted" data-testid="taste-empty">
            {t("fy.taste.empty")}
          </p>
          <PreferencesPanel />
        </div>
      ) : (
        <div className="space-y-5" data-testid="taste">
          <PreferencesPanel />
          <SignalTiles d={d} />
          <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            <Panel title={t("fy.taste.histogram")}>
              <Histogram values={d.rating_histogram} />
            </Panel>
            <Panel title={t("fy.taste.kinds")}>
              <KindsDonut movie={d.kinds.movie} series={d.kinds.series} />
            </Panel>
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title={t("fy.taste.genres")} testId="taste-genres">
              <Affinities items={d.genres} />
            </Panel>
            <Panel title={t("fy.taste.decades")} testId="taste-decades">
              <Decades items={d.decades} />
            </Panel>
            {!!d.countries.length && (
              <Panel title={t("fy.taste.countries")}>
                <Affinities items={d.countries} max={6} />
              </Panel>
            )}
            {!!d.languages.length && (
              <Panel title={t("fy.taste.languages")}>
                <Affinities items={d.languages} max={6} />
              </Panel>
            )}
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <Panel title={t("fy.taste.directors")} testId="taste-directors">
              <People items={d.directors} />
            </Panel>
            <Panel title={t("fy.taste.actors")}>
              <People items={d.actors} />
            </Panel>
          </div>
          {!!d.adjustments?.length && (
            <Panel title={t("taste.adjust.title")} testId="taste-adjustments">
              <ul className="space-y-1.5 text-sm">
                {d.adjustments.map((a) => (
                  <li key={a.reason} data-reason={a.reason}>
                    {a.reason === "too_long"
                      ? t("taste.adjust.too_long", { n: a.titles, minutes: a.runtime_max ?? 0 })
                      : t(a.reason === "too_scary" ? "taste.adjust.too_scary" : "taste.adjust.childish", { n: a.titles, genres: a.genre_names.join(", ") })}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          {d.credits_coverage.total > 0 && d.credits_coverage.with_credits < d.credits_coverage.total && (
            <p className="text-xs text-muted">{t("fy.taste.coverage", { n: d.credits_coverage.with_credits, total: d.credits_coverage.total })}</p>
          )}
        </div>
      )}
    </div>
  );
}

function Panel({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5" data-testid={testId}>
      <h2 className="mb-3 font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function SignalTiles({ d }: { d: TasteDNA }) {
  const { t } = useI18n();
  const s = d.signals;
  const tiles: [MessageKey, string | number][] = [
    ["fy.taste.ratings", s.ratings],
    ["fy.taste.completed", s.completed],
    ["fy.taste.average", s.average_rating != null ? s.average_rating.toFixed(1) : "—"],
    ["fy.taste.favorites", s.favorites],
    ["fy.taste.rewatches", s.rewatches],
    ["fy.taste.dismissed", s.dismissed],
  ];
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
      {tiles.map(([k, v]) => (
        <div key={k} className="rounded-2xl border border-border bg-surface p-3">
          <p className="text-2xl font-extrabold tabular-nums">{v}</p>
          <p className="text-xs leading-tight text-muted">{t(k)}</p>
        </div>
      ))}
    </div>
  );
}

/** Ratings 1…10 as columns (one hue), count labels on the tallest only. */
function Histogram({ values }: { values: number[] }) {
  const { t } = useI18n();
  const W = 400;
  const H = 150;
  const bars = histogramBars(values, W, H, 6);
  const total = values.reduce((a, b) => a + b, 0);
  const max = Math.max(...values);
  return (
    <figure data-testid="taste-histogram">
      <svg viewBox={`0 0 ${W} ${H + 40}`} className="w-full" role="img" aria-label={t("fy.taste.histogram")}>
        <line x1={0} x2={W} y1={H + 0.5} y2={H + 0.5} stroke="rgb(var(--mt-border))" />
        {bars.map((b, i) => (
          <g key={i}>
            <title>{`★ ${i + 1}: ${b.value} (${percent(b.value, total)}%)`}</title>
            {/* Invisible hit target taller than the bar. */}
            <rect x={b.x} y={0} width={b.w} height={H} fill="transparent" />
            {b.h > 0 && <path d={roundedTop(b.x, b.y, b.w, b.h, 4)} fill={POS} opacity={0.35 + 0.65 * ((i + 1) / 10)} />}
            {b.value === max && max > 0 && (
              <text x={b.x + b.w / 2} y={b.y - 6} textAnchor="middle" fontSize={12} fontWeight={700} fill="rgb(var(--mt-text))">
                {b.value}
              </text>
            )}
            <text x={b.x + b.w / 2} y={H + 20} textAnchor="middle" fontSize={13} fill="rgb(var(--mt-muted))">
              {i + 1}
            </text>
          </g>
        ))}
      </svg>
    </figure>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M ${x} ${y + h} V ${y + rr} Q ${x} ${y} ${x + rr} ${y} H ${x + w - rr} Q ${x + w} ${y} ${x + w} ${y + rr} V ${y + h} Z`;
}

function KindsDonut({ movie, series }: { movie: number; series: number }) {
  const { t } = useI18n();
  const total = movie + series;
  const f = total ? movie / total : 0;
  return (
    <div className="flex items-center gap-5" data-testid="taste-kinds">
      <svg viewBox="0 0 120 120" className="h-32 w-32 shrink-0" role="img" aria-label={t("fy.taste.kinds")}>
        <circle cx={60} cy={60} r={46} fill="none" stroke="rgb(var(--mt-surface-2))" strokeWidth={16} />
        {movie > 0 && (
          <path d={arcPath(60, 60, 46, 0, f)} fill="none" stroke={POS} strokeWidth={16}>
            <title>{`${t("fy.taste.movies")}: ${movie}`}</title>
          </path>
        )}
        {series > 0 && (
          <path d={arcPath(60, 60, 46, f, 1)} fill="none" stroke={NEG} strokeWidth={16}>
            <title>{`${t("fy.taste.series")}: ${series}`}</title>
          </path>
        )}
        <text x={60} y={66} textAnchor="middle" fontSize={20} fontWeight={800} fill="rgb(var(--mt-text))">
          {total}
        </text>
      </svg>
      <ul className="space-y-2 text-sm">
        <Legend color={POS} label={t("fy.taste.movies")} value={`${movie} · ${percent(movie, total)}%`} />
        <Legend color={NEG} label={t("fy.taste.series")} value={`${series} · ${percent(series, total)}%`} />
      </ul>
    </div>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className="h-3 w-3 rounded-sm" style={{ background: color }} aria-hidden />
      <span className="font-medium">{label}</span>
      <span className="tabular-nums text-muted">{value}</span>
    </li>
  );
}

/** Likes (accent, right of the centre) and dislikes (sky, left), centred on a neutral line. */
function Affinities({ items, max = 8 }: { items: Affinity[]; max?: number }) {
  const { t } = useI18n();
  const { likes, dislikes } = splitAffinities(items, max);
  if (!likes.length && !dislikes.length) return <p className="text-sm text-muted">—</p>;
  return (
    <div className="space-y-3">
      {likes.length > 0 && <AffinityList title={t("fy.taste.likes")} items={likes} />}
      {dislikes.length > 0 && <AffinityList title={t("fy.taste.dislikes")} items={dislikes} />}
    </div>
  );
}

function AffinityList({ title, items }: { title: string; items: Affinity[] }) {
  const { t } = useI18n();
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">{title}</p>
      <ul className="space-y-1.5">
        {items.map((a) => {
          const bar = divergingBar(a.score);
          return (
            <li key={a.key} className="grid grid-cols-[minmax(0,8rem)_1fr_2.5rem] items-center gap-2 text-sm" title={`${a.name}: ${a.score.toFixed(2)} · ${t("fy.taste.titles", { n: a.count })}`}>
              <span className="truncate">{a.name}</span>
              <span className="relative h-2.5 rounded-full bg-surface-2">
                <span className="absolute inset-y-0 left-1/2 w-px bg-border" aria-hidden />
                <span className="absolute inset-y-0 rounded-full" style={{ left: `${bar.left}%`, width: `${Math.max(bar.width, 1)}%`, background: a.score >= 0 ? POS : NEG }} />
              </span>
              <span className="text-right text-xs tabular-nums text-muted">{a.count}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Decades in time order: columns by title count, coloured by liking. */
function Decades({ items }: { items: Affinity[] }) {
  const { t } = useI18n();
  const sorted = [...items].sort((a, b) => Number(a.key) - Number(b.key));
  if (!sorted.length) return <p className="text-sm text-muted">—</p>;
  const W = 400;
  const H = 120;
  const bars = histogramBars(sorted.map((d) => d.count), W, H, 6);
  return (
    <svg viewBox={`0 0 ${W} ${H + 30}`} className="w-full" role="img" aria-label={t("fy.taste.decades")}>
      <line x1={0} x2={W} y1={H + 0.5} y2={H + 0.5} stroke="rgb(var(--mt-border))" />
      {bars.map((b, i) => {
        const d = sorted[i]!;
        return (
          <g key={d.key}>
            <title>{`${d.name}: ${t("fy.taste.titles", { n: d.count })} · ${d.score.toFixed(2)}`}</title>
            <rect x={b.x} y={0} width={b.w} height={H} fill="transparent" />
            {b.h > 0 && <path d={roundedTop(b.x, b.y, b.w, b.h, 4)} fill={d.score >= 0 ? POS : NEG} opacity={0.45 + 0.55 * Math.min(1, Math.abs(d.score) * 2)} />}
            <text x={b.x + b.w / 2} y={H + 20} textAnchor="middle" fontSize={sorted.length > 9 ? 10 : 12} fill="rgb(var(--mt-muted))">
              {`’${d.key.slice(2, 4)}`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function People({ items }: { items: Person[] }) {
  const { t } = useI18n();
  const { data: cfg } = useCatalogConfig();
  const top = [...items].sort((a, b) => b.score - a.score).slice(0, 8);
  if (!top.length) return <p className="text-sm text-muted">—</p>;
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {top.map((p) => (
        <li key={p.tmdb_id} className="flex items-center gap-2 rounded-xl bg-bg/40 p-1.5" title={`${p.name}: ${p.score.toFixed(2)}`}>
          <span className="relative h-10 w-10 shrink-0 overflow-hidden rounded-full" style={{ background: placeholderColor(p.name) }}>
            <Img src={imageUrl(cfg, p.profile_path, "w185")} alt="" className="absolute inset-0 h-full w-full object-cover" fallback={<span className="flex h-full w-full items-center justify-center text-sm font-bold text-white/90">{p.name[0]}</span>} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{p.name}</span>
            <span className="block text-xs text-muted">{t("fy.taste.titles", { n: p.count })}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

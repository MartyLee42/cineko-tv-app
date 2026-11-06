import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import type { MediaSummary } from "@martytv/contracts";
import { formatRating, imageUrl, placeholderColor } from "@martytv/media-types";
import {
  EMPTY_SURPRISE,
  moodLabel,
  reasonText,
  surpriseRequest,
  toggleIn,
  useI18n,
  type MessageKey,
  type Mood,
  type RuntimeBucket,
  type SurpriseForm,
  type SurpriseKind,
} from "@martytv/ui";
import { ErrorText } from "../components";
import { CatalogPage, Img } from "../catalog/components";
import { useCatalogConfig, useGenres } from "../catalog/queries";
import { CastIcon, DeviceIcon, EyeIcon, PlayIcon, RefreshIcon } from "../icons";
import { NoProfile } from "../pages/HistoryPage";
import { PlayOnTvProvider, usePlayOnTv, useWatchHere } from "../play/PlayOnTv";
import { SendToTvProvider, useSendToTv } from "../remote/SendToTv";
import { useActiveProfile } from "../watch/ActiveProfile";
import { sendFeedback, trackOpen, useDismiss, useSurprise, useSurpriseOptions, type SurpriseResult } from "./queries";

const SPOILER_KEY = "martytv.surprise.spoiler_free";
const RATINGS = [6, 7, 8];
const RUNTIMES: Exclude<RuntimeBucket, "any">[] = ["short", "medium", "long"];
const KINDS: SurpriseKind[] = ["movie", "series", "any"];

function readSpoiler(): boolean {
  try {
    return localStorage.getItem(SPOILER_KEY) !== "0";
  } catch {
    return true;
  }
}

/** «Удиви меня!»: a few filters, one weighted-random pick, spoiler-free reveal, reroll. */
export function SurprisePage() {
  return (
    <SendToTvProvider>
      <PlayOnTvProvider>
        <Surprise />
      </PlayOnTvProvider>
    </SendToTvProvider>
  );
}

function Surprise() {
  const { t } = useI18n();
  const { profile, profileId } = useActiveProfile();
  const opts = useSurpriseOptions();
  const genresQ = useGenres("movie");
  const surprise = useSurprise();
  const [form, setForm] = useState<SurpriseForm>(EMPTY_SURPRISE);
  const [spoilerFree, setSpoilerFree] = useState(readSpoiler);
  const [result, setResult] = useState<SurpriseResult | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  const set = (patch: Partial<SurpriseForm>) => setForm((f) => ({ ...f, ...patch }));
  const run = (exclude: string[] = []) => {
    if (!profileId) return;
    surprise.mutate(surpriseRequest(form, profileId, exclude), {
      onSuccess: (r) => {
        setResult(r);
        setRevealed(false);
        if (r.media) sendFeedback(profileId, r.media.id, "impression", "surprise");
      },
    });
  };
  const toggleSpoiler = () => {
    const v = !spoilerFree;
    setSpoilerFree(v);
    try {
      localStorage.setItem(SPOILER_KEY, v ? "1" : "0");
    } catch {
      // private mode
    }
  };
  const genreNames = useMemo(() => new Map((genresQ.data ?? []).map((g) => [g.id, g.name])), [genresQ.data]);
  const filtersOn = form.genres.length + (form.runtime !== "any" ? 1 : 0) + (form.decade ? 1 : 0) + (form.minRating ? 1 : 0) + (form.includeWatched ? 1 : 0);

  if (!profile) return <NoProfile />;
  return (
    <CatalogPage>
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="text-center">
          <h1 className="text-3xl font-extrabold sm:text-4xl">🎲 {t("fy.surprise.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("fy.surprise.subtitle")}</p>
        </header>

        <Group label={t("fy.surprise.mood")}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="surprise-moods">
            <MoodChip on={!form.mood} onClick={() => set({ mood: null })} emoji="✨" label={t("fy.surprise.any")} />
            {(opts.data?.moods ?? []).map((m) => (
              <MoodChip key={m.key} on={form.mood === m.key} onClick={() => set({ mood: form.mood === m.key ? null : (m.key as Mood) })} emoji={m.emoji} label={moodLabel(m.key, t)} testId={`mood-${m.key}`} />
            ))}
          </div>
        </Group>

        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={form.kind}
            options={KINDS.map((k) => ({ value: k, label: t(`fy.surprise.kind_${k}` as MessageKey) }))}
            onChange={(kind) => set({ kind })}
            label={t("fy.surprise.kind")}
          />
          <button
            type="button"
            aria-expanded={showFilters}
            onClick={() => setShowFilters((v) => !v)}
            data-testid="surprise-filters-toggle"
            className="min-h-[40px] rounded-full border border-border bg-surface px-4 text-sm font-semibold hover:border-muted"
          >
            {t("fy.surprise.filters")}
            {filtersOn > 0 && <span className="ml-1.5 rounded-full bg-accent px-1.5 text-xs text-on-accent">{filtersOn}</span>}
          </button>
          <label className="ml-auto flex min-h-[40px] cursor-pointer items-center gap-2 text-sm" title={t("fy.surprise.spoiler_hint")}>
            <input type="checkbox" checked={spoilerFree} onChange={toggleSpoiler} data-testid="surprise-spoiler" className="h-4 w-4 accent-[rgb(var(--mt-accent))]" />
            {t("fy.surprise.spoiler_free")}
          </label>
        </div>

        {showFilters && (
          <div className="space-y-4 rounded-2xl border border-border bg-surface p-4" data-testid="surprise-filters">
            <Group label={t("fy.surprise.genres")}>
              <div className="flex flex-wrap gap-1.5">
                {(genresQ.data ?? []).map((g) => (
                  <Chip key={g.id} on={form.genres.includes(g.id)} onClick={() => set({ genres: toggleIn(form.genres, g.id) })}>
                    {g.name}
                  </Chip>
                ))}
              </div>
            </Group>
            <div className="grid gap-4 sm:grid-cols-2">
              <Group label={t("fy.surprise.runtime")}>
                <div className="flex flex-wrap gap-1.5">
                  <Chip on={form.runtime === "any"} onClick={() => set({ runtime: "any" })}>
                    {t("fy.surprise.any")}
                  </Chip>
                  {RUNTIMES.map((r) => (
                    <Chip key={r} on={form.runtime === r} onClick={() => set({ runtime: r })}>
                      {t(`fy.surprise.runtime_${r}` as MessageKey)}
                    </Chip>
                  ))}
                </div>
              </Group>
              <Group label={t("fy.surprise.min_rating")}>
                <div className="flex flex-wrap gap-1.5">
                  <Chip on={!form.minRating} onClick={() => set({ minRating: null })}>
                    {t("fy.surprise.any")}
                  </Chip>
                  {RATINGS.map((r) => (
                    <Chip key={r} on={form.minRating === r} onClick={() => set({ minRating: r })}>
                      ★ {r}+
                    </Chip>
                  ))}
                </div>
              </Group>
            </div>
            <Group label={t("fy.surprise.decade")}>
              <div className="flex flex-wrap gap-1.5">
                <Chip on={!form.decade} onClick={() => set({ decade: null })}>
                  {t("fy.surprise.any")}
                </Chip>
                {(opts.data?.decades ?? []).map((d) => (
                  <Chip key={d} on={form.decade === d} onClick={() => set({ decade: d })}>
                    {t("fy.surprise.decade_label", { decade: d })}
                  </Chip>
                ))}
              </div>
            </Group>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex min-h-[40px] cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" checked={form.includeWatched} onChange={(e) => set({ includeWatched: e.target.checked })} className="h-4 w-4" data-testid="surprise-watched" />
                {t("fy.surprise.include_watched")}
              </label>
              <button type="button" onClick={() => setForm({ ...EMPTY_SURPRISE, mood: form.mood, kind: form.kind })} className="text-sm text-muted underline hover:text-text">
                {t("fy.surprise.reset")}
              </button>
            </div>
          </div>
        )}

        <div className="flex justify-center">
          <button
            type="button"
            data-testid="surprise-go"
            disabled={surprise.isPending}
            onClick={() => run()}
            className="inline-flex min-h-[56px] items-center gap-3 rounded-2xl bg-accent px-10 text-lg font-extrabold text-on-accent shadow-xl shadow-accent/25 transition hover:bg-accent-strong active:scale-[.98] disabled:opacity-60"
          >
            <span className={surprise.isPending ? "animate-spin" : ""} aria-hidden>
              🎲
            </span>
            {t("fy.surprise.go")}
          </button>
        </div>
        <ErrorText error={surprise.error} />

        {result && (
          <ResultCard
            result={result}
            spoilerFree={spoilerFree}
            revealed={revealed}
            busy={surprise.isPending}
            genreNames={genreNames}
            onReveal={() => setRevealed(true)}
            onReroll={() => run(result.reroll.exclude_ids)}
          />
        )}
      </div>
    </CatalogPage>
  );
}

function ResultCard({
  result,
  spoilerFree,
  revealed,
  busy,
  genreNames,
  onReveal,
  onReroll,
}: {
  result: SurpriseResult;
  spoilerFree: boolean;
  revealed: boolean;
  busy: boolean;
  genreNames: Map<number, string>;
  onReveal: () => void;
  onReroll: () => void;
}) {
  const { t } = useI18n();
  const m = result.media;
  if (!m) {
    return (
      <div data-testid="surprise-none" className="rounded-3xl border border-dashed border-border bg-surface p-10 text-center text-muted">
        <p className="text-4xl" aria-hidden>
          🤷
        </p>
        <p className="mt-3">{t("fy.surprise.none")}</p>
      </div>
    );
  }
  const hidden = spoilerFree && !revealed;
  const why = result.reason ? reasonText(result.reason, t) : null;
  const genres = m.genre_ids.map((id) => genreNames.get(id)).filter(Boolean).slice(0, 3) as string[];
  return (
    <article data-testid="surprise-result" data-hidden={hidden ? "1" : "0"} className={`overflow-hidden rounded-3xl border border-border bg-surface shadow-2xl shadow-black/30 transition ${busy ? "opacity-60" : ""}`}>
      <div className="grid sm:grid-cols-[240px_1fr]">
        <PosterOrMystery m={m} hidden={hidden} onReveal={onReveal} />
        <div className="flex flex-col gap-3 p-5 sm:p-7">
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
            {genres.map((g) => (
              <span key={g} className="rounded-full bg-surface-2 px-2.5 py-1">
                {g}
              </span>
            ))}
            {m.year && <span className="rounded-full bg-surface-2 px-2.5 py-1">{m.year}</span>}
            <span className="rounded-full bg-surface-2 px-2.5 py-1">{t(`catalog.kind.${m.kind}` as MessageKey)}</span>
            {formatRating(m.kp_rating ?? m.rating) && <span className="rounded-full bg-accent/15 px-2.5 py-1 text-text">★ {formatRating(m.kp_rating ?? m.rating)}</span>}
          </div>
          {hidden ? (
            <h2 className="text-2xl font-extrabold text-muted sm:text-3xl" data-testid="surprise-mystery">
              {t("fy.surprise.mystery")}
            </h2>
          ) : (
            <h2 className="text-2xl font-extrabold sm:text-3xl" data-testid="surprise-title">
              {m.title}
            </h2>
          )}
          {why && (
            <p className="border-l-2 border-accent pl-2.5 text-sm font-medium text-text/85" data-testid="surprise-reason">
              {why}
            </p>
          )}
          {!hidden && m.overview && <p className="line-clamp-4 text-sm leading-relaxed text-text/85">{m.overview}</p>}
          <p className="text-xs text-muted">
            {[t("fy.surprise.pool", { n: result.pool_size }), result.source === "discover" ? t("fy.surprise.from_discover") : null].filter(Boolean).join(" · ")}
          </p>
          <div className="mt-auto flex flex-wrap gap-2 pt-2">
            {hidden ? (
              <button type="button" data-testid="surprise-reveal" onClick={onReveal} className="inline-flex min-h-[48px] items-center gap-2 rounded-xl bg-accent px-6 font-bold text-on-accent hover:bg-accent-strong">
                <EyeIcon /> {t("fy.surprise.reveal")}
              </button>
            ) : (
              <WatchActions m={m} />
            )}
            <button type="button" data-testid="surprise-reroll" disabled={busy} onClick={onReroll} className="inline-flex min-h-[48px] items-center gap-2 rounded-xl bg-surface-2 px-5 font-semibold hover:bg-border disabled:opacity-60">
              <RefreshIcon /> {t("fy.surprise.reroll")}
            </button>
            <NotInterested m={m} onDone={onReroll} />
          </div>
        </div>
      </div>
    </article>
  );
}

function PosterOrMystery({ m, hidden, onReveal }: { m: MediaSummary; hidden: boolean; onReveal: () => void }) {
  const { t } = useI18n();
  const { data: cfg } = useCatalogConfig();
  if (hidden) {
    return (
      <button
        type="button"
        onClick={onReveal}
        aria-label={t("fy.surprise.reveal")}
        className="relative flex aspect-[2/3] max-h-[360px] w-full items-center justify-center overflow-hidden bg-gradient-to-br from-accent/40 via-surface-2 to-fuchsia-500/30 sm:max-h-none"
      >
        <span className="text-7xl font-black text-white/80 drop-shadow-lg">?</span>
        <span className="absolute bottom-3 rounded-full bg-black/50 px-3 py-1 text-xs font-semibold text-white">{t("fy.surprise.reveal")}</span>
      </button>
    );
  }
  return (
    <Link to={`/title/${m.id}`} className="relative block aspect-[2/3] max-h-[360px] w-full overflow-hidden sm:max-h-none" style={{ background: placeholderColor(m.title) }}>
      <Img src={imageUrl(cfg, m.poster_path, "w500")} alt={m.title} className="absolute inset-0 h-full w-full object-cover" fallback={null} />
    </Link>
  );
}

/** «Смотреть» (here) / «На ТВ» / «Подробнее» using the existing play flows. */
function WatchActions({ m }: { m: MediaSummary }) {
  const { t } = useI18n();
  const { profileId } = useActiveProfile();
  const navigate = useNavigate();
  const watchHere = useWatchHere();
  const { play } = usePlayOnTv();
  const { request } = useSendToTv();
  const played = () => sendFeedback(profileId, m.id, "play", "surprise");
  const target = { media_id: m.id, label: m.title };
  const btn = "inline-flex min-h-[48px] items-center gap-2 rounded-xl px-5 font-semibold";
  return (
    <>
      <button
        type="button"
        data-testid="surprise-watch"
        className={`${btn} bg-accent font-bold text-on-accent hover:bg-accent-strong`}
        onClick={() => {
          if (m.kind === "movie") {
            played();
            watchHere(target);
          } else {
            trackOpen(profileId, m.id, "surprise");
            navigate(`/title/${m.id}`);
          }
        }}
      >
        {m.kind === "movie" ? <DeviceIcon /> : <PlayIcon />} {t("fy.surprise.watch")}
      </button>
      <button
        type="button"
        data-testid="surprise-tv"
        className={`${btn} border border-border bg-surface-2 hover:border-accent`}
        onClick={() => {
          if (m.kind === "movie") {
            played();
            play(target);
          } else request({ media_id: m.id });
        }}
      >
        <CastIcon /> {t("fy.surprise.on_tv")}
      </button>
      <Link to={`/title/${m.id}`} onClick={() => trackOpen(profileId, m.id, "surprise")} className={`${btn} text-muted hover:text-text`}>
        {t("fy.surprise.details")}
      </Link>
    </>
  );
}

function NotInterested({ m, onDone }: { m: MediaSummary; onDone: () => void }) {
  const { t } = useI18n();
  const dismiss = useDismiss();
  return (
    <button
      type="button"
      data-testid="surprise-dismiss"
      onClick={() => dismiss.mutate({ mediaId: m.id, rowId: "surprise" }, { onSettled: onDone })}
      className="inline-flex min-h-[48px] items-center rounded-xl px-3 text-sm text-muted hover:text-danger"
    >
      {t("fy.dismiss")}
    </button>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{label}</p>
      {children}
    </div>
  );
}

function MoodChip({ on, onClick, emoji, label, testId }: { on: boolean; onClick: () => void; emoji: string; label: string; testId?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      data-testid={testId}
      className={`flex min-h-[56px] items-center gap-2.5 rounded-2xl border px-3 text-left text-sm font-semibold transition ${
        on ? "border-accent bg-accent/15 text-text shadow-md shadow-accent/10" : "border-border bg-surface hover:border-muted"
      }`}
    >
      <span className="text-2xl" aria-hidden>
        {emoji}
      </span>
      <span className="min-w-0 leading-tight">{label}</span>
    </button>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`min-h-[36px] rounded-full border px-3 text-sm transition ${on ? "border-accent bg-accent/15 text-text" : "border-border hover:border-muted"}`}
    >
      {children}
    </button>
  );
}

function Segmented<V extends string>({ value, options, onChange, label }: { value: V; options: { value: V; label: string }[]; onChange: (v: V) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-full border border-border bg-surface p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`min-h-[34px] rounded-full px-4 text-sm font-semibold transition ${o.value === value ? "bg-accent text-on-accent" : "text-muted hover:text-text"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

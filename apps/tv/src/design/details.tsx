// Details' header per design: Кинозал (p5), Терминал (p8), Проектор (p11).
// Data, focus keys and handlers come from DetailsScreen; these only lay out.
import { useMemo, type ReactNode } from "react";
import { useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import type { CatalogConfig, MediaDetail, MediaSummary, Release, WatchProgress } from "@martytv/contracts";
import { formatRuntime, imageUrl, countryList, fitInput, judgeFit, type Fit } from "@martytv/media-types";
import { thisTvCaps } from "../player/fitCaps";
import { FitLine } from "../player/FitLine";
import { useConstructivism, useI18n } from "@martytv/ui";
import { FocusBlock, FocusButton, useFocusRecorder } from "../focus";
import { Backdrop, Img } from "../components/Img";
import { ProgressBar } from "../components/Poster";
import { formatClock } from "../player/format";
import { barFraction } from "../watch/resume";
import { useSettings } from "../profile/settings";
import { usePlural, useSkin, type Design } from "./context";
import { RATING_LABEL, ratingList, runtimeClock, splitTitle, summarizeRelease, type ReleaseSummary } from "./format";
import { RatingRow } from "./hero";
import { plateTitleSize, TitlePlate, useTitlePlate, useTitleScale } from "./skins";
import { BackIcon, BookmarkIcon, ListIcon, MoreIcon, PlusIcon, CheckIcon, PlayGlyph, TrailerIcon } from "./icons";
import { WaveCheckIcon, WaveMoreIcon, WavePlusIcon } from "./waveIcons";
import { ExtrasLine, type ExtraChip } from "./trivia";

export interface SourceState {
  status: "idle" | "loading" | "ok" | "none" | "error";
  /** The auto-selected release (what «Смотреть» plays). */
  best: Release | null;
  items: Release[];
}

export interface DetailActions {
  playLabel: string;
  onPlay: () => void;
  onSources: () => void;
  onTrailer: (() => void) | null;
  /** Watchlist state (null = unknown: button hidden). */
  inList: boolean | null;
  onList: () => void;
  onMore: () => void;
  onRelease: (r: Release) => void;
  /** «Уточнить поиск» (refine the release search). */
  onRefine: () => void;
  /** «Смотреть онлайн» (no torrent): null/absent = no online variants (button hidden). */
  onOnline?: (() => void) | null;
  /** «Награды» panel: null/absent = no awards (line hidden). */
  onAwards?: (() => void) | null;
  /** «Цитаты» panel: null/absent = none found (button hidden; shown while loading). */
  onQuotes?: (() => void) | null;
  /** «Факты» panel. */
  onFacts?: (() => void) | null;
  /** «Ранее в сериале» / «После титров» chips (shown only when available). */
  extras?: ExtraChip[];
}

export interface HeaderProps {
  item: MediaSummary;
  detail?: MediaDetail;
  cfg?: CatalogConfig;
  from?: string;
  profileName: string;
  progress: WatchProgress | null;
  sources: SourceState;
  actions: DetailActions;
  /** Extra block on the right (a recommendation note). */
  aside?: ReactNode;
}

/** Height of each design's header block (lower sections start below it). */
export const HEADER_H: Record<Design, number> = { kinozal: 830, terminal: 1010, projector: 860 };

function useMeta(item: MediaSummary, detail?: MediaDetail) {
  const { locale } = useI18n();
  const plural = usePlural();
  const runtime = item.kind === "movie" ? formatRuntime(detail?.runtime, locale) : null;
  const seasons = item.kind === "series" && detail?.number_of_seasons ? plural("tvd.seasons", detail.number_of_seasons) : null;
  const genres = detail ? detail.genres.slice(0, 2).map((g) => g.name).join(", ") : null;
  const countries = countryList(detail?.countries, locale, 2);
  return [item.year ? String(item.year) : null, countries, runtime, seasons, genres || null].filter((x): x is string => !!x);
}

function useRatings(item: MediaSummary) {
  const s = useSettings().poster_rating;
  return ratingList(item, s === "off" ? "kp" : s);
}

function people(item: MediaSummary, detail?: MediaDetail): string[] {
  const job = item.kind === "series" ? "Creator" : "Director";
  return (detail?.crew ?? []).filter((c) => c.job === job).map((c) => c.name);
}

/** The localized voice-over label of a release summary. */
function useVoice() {
  const { t } = useI18n();
  return (s: ReleaseSummary) => (s.voice ? t(`tvd.voice.${s.voice}`) : s.studio);
}

/** Movie: resume bar under the overview (kept for every design). */
function MovieProgress({ progress, className = "" }: { progress: WatchProgress | null; className?: string }) {
  const { t } = useI18n();
  if (!progress) return null;
  if (progress.completed) return <p className={`text-[24px] text-accent ${className}`}>✓ {t("watch.watched")}</p>;
  const f = barFraction(progress.percent);
  if (f === null) return null;
  return (
    <div data-testid="movie-progress" className={`flex items-center ${className}`}>
      <div className="relative h-[6px] w-[420px] overflow-hidden rounded-full">
        <ProgressBar fraction={f} className="h-full rounded-full" />
      </div>
      <span className="ml-6 text-[22px] text-muted">
        {formatClock(progress.position_seconds)}
        {progress.duration_seconds ? ` / ${formatClock(progress.duration_seconds)}` : ""}
      </span>
    </div>
  );
}

// ================================================================ Кинозал (p5)

export function KinozalBackdrop({ item, cfg, dim }: { item?: MediaSummary; cfg?: CatalogConfig; dim: boolean }) {
  return (
    <div className={`tv-fade absolute top-0 ${dim ? "opacity-30" : "opacity-100"}`} style={{ left: 560, width: 1360, height: 900 }}>
      <Backdrop src={imageUrl(cfg, item?.backdrop_path, "w1280")} />
      <div className="k-fade-left absolute left-0 top-0 h-full w-full" />
      <div className="k-fade-bottom absolute left-0 top-0 h-full w-full" />
    </div>
  );
}

export function KinozalHeader({ item, detail, from, progress, sources, actions, aside }: HeaderProps) {
  const { t, locale } = useI18n();
  const meta = useMeta(item, detail);
  const ratings = useRatings(item);
  const voice = useVoice();
  const s = sources.best ? summarizeRelease(sources.best, locale) : null;
  const plural = usePlural();
  const plate = useTitlePlate();
  return (
    <div className="relative" style={{ height: HEADER_H.kinozal }}>
      <div className="absolute left-[96px] top-[54px] flex items-center text-[21px] text-muted">
        <span className="mr-4 flex h-[42px] w-[42px] items-center justify-center rounded-[10px] border-2 border-text/30 text-text/80">
          <BackIcon size={22} stroke={2} />
        </span>
        {from ? t("tvd.back_to", { row: from }) : t("tvd.back")}
      </div>
      <div className="absolute left-[168px] top-[150px] w-[1060px]">
        {/* Ар-деко frames the title in a marquee plate (with the kind); other skins: eyebrow + title. */}
        <TitlePlate kind={t(`catalog.kind.${item.kind}`)} eyebrow={<p className="text-[21px] font-bold uppercase tracking-[.16em] text-accent">{t(`catalog.kind.${item.kind}`)}</p>}>
          <h1 className="mt-3 line-clamp-2 font-bold leading-[1.1] tracking-[-.02em]" style={{ fontSize: plate ? plateTitleSize(item.title) : item.title.length > 28 ? 64 : 84 }}>
            {item.title}
          </h1>
        </TitlePlate>
        {detail?.tagline && <p className="mt-3 truncate text-[28px] italic text-text/85">«{detail.tagline.replace(/^[«"]|[»"]$/g, "")}»</p>}
        <div className="mt-5 flex items-center text-[26px] text-text/85">
          <RatingRow ratings={ratings} />
          {meta.map((m, i) => (
            <span key={i} className="flex items-center whitespace-nowrap">
              {(i > 0 || ratings.length > 0) && <span className="mx-[14px] text-[18px] text-muted">•</span>}
              {m}
            </span>
          ))}
        </div>
        <ExtrasLine awards={detail?.awards} onAwards={actions.onAwards ?? null} onQuotes={actions.onQuotes ?? null} onFacts={actions.onFacts ?? null} extra={actions.extras} className="-ml-4 mt-3" />
        <p className="mt-5 line-clamp-3 w-[880px] text-[25px] leading-[1.45] text-text/75">{item.overview || t("catalog.detail.no_overview")}</p>
        <MovieProgress progress={progress} className="mt-5" />
        <div className="mt-8 flex items-center">
          <FocusButton focusKey="d-play" onPress={actions.onPlay} className="k-primary flex h-[76px] items-center rounded-[14px] px-[38px] text-[28px] font-bold">
            <span className="mr-4 text-[22px]">▶</span>
            {actions.playLabel}
          </FocusButton>
          {actions.onOnline && (
            <FocusButton focusKey="d-online" onPress={actions.onOnline} className="k-icon-btn ml-[18px] flex h-[76px] items-center rounded-[14px] px-[30px] text-[26px] font-bold text-text" focusedClassName="!bg-text !text-bg">
              {t("online.watch")}
            </FocusButton>
          )}
          <IconBtn k="d-sources" onPress={actions.onSources}>
            <ListIcon size={32} />
          </IconBtn>
          {actions.onTrailer && (
            <IconBtn k="d-trailer" onPress={actions.onTrailer}>
              <TrailerIcon size={32} />
            </IconBtn>
          )}
          {actions.inList !== null && (
            <IconBtn k="d-list" onPress={actions.onList} active={actions.inList}>
              <BookmarkIcon size={30} filled={actions.inList} />
            </IconBtn>
          )}
          <IconBtn k="d-more" onPress={actions.onMore}>
            <MoreIcon size={32} />
          </IconBtn>
        </div>
        <div data-testid="source-line" data-status={sources.status} className="mt-6 flex items-center text-[22px] text-muted">
          <span className={`mr-3 inline-block h-[13px] w-[13px] shrink-0 rounded-full ${sources.status === "ok" ? "bg-ok" : sources.status === "loading" ? "bg-muted tv-pulse" : "bg-danger"}`} />
          {sources.status === "ok" && s ? (
            <span className="truncate">
              {t("tvd.source.auto")}{" "}
              <span data-release-id={sources.best!.id} className="text-text">
                {[s.quality, s.hdr, voice(s), s.audio, s.size, plural("tvd.seeds", s.seeders)].filter(Boolean).join(" · ")}
              </span>{" "}
              · ☰ {t("tvd.source.change")}
            </span>
          ) : sources.status === "loading" || sources.status === "idle" ? (
            <span>{t("tvd.source.searching")}</span>
          ) : sources.status === "none" ? (
            <span>{t("tvd.source.none")}</span>
          ) : (
            <span>{t("tvd.source.error")}</span>
          )}
        </div>
      </div>
      {aside && <div className="absolute right-[96px] top-[560px] w-[600px]">{aside}</div>}
    </div>
  );
}

function IconBtn({ k, onPress, active, children }: { k: string; onPress: () => void; active?: boolean; children: ReactNode }) {
  return (
    <FocusButton focusKey={k} onPress={onPress} className={`k-icon-btn ml-[18px] flex h-[76px] w-[76px] items-center justify-center rounded-[14px] ${active ? "text-accent" : "text-text"}`} focusedClassName="!bg-text !text-bg">
      {children}
    </FocusButton>
  );
}

// ================================================================ Терминал (p8)

export function TerminalBackdrop({ item, cfg, dim }: { item?: MediaSummary; cfg?: CatalogConfig; dim: boolean }) {
  return (
    <div className={`tv-fade absolute left-0 top-0 w-full overflow-hidden ${dim ? "opacity-30" : "opacity-100"}`} style={{ height: 470 }}>
      {item?.backdrop_path && <Img src={imageUrl(cfg, item.backdrop_path, "w1280")} className="t-mono-img absolute left-0 top-0 h-full w-full object-cover" />}
      <div className="t-scanlines absolute left-0 top-0 h-full w-full" />
      <div className="t-band-fade absolute left-0 top-0 h-full w-full" />
    </div>
  );
}

export function TerminalHeader({ item, detail, from, profileName, progress, sources, actions, aside }: HeaderProps) {
  const { t, locale } = useI18n();
  // «Конструктивизм»: its pictograms instead of the ▶ / ⋯ glyphs.
  const cv = useConstructivism();
  const ratings = useRatings(item);
  const voice = useVoice();
  const cols: { label: string; value: string }[] = [];
  if (item.year) cols.push({ label: t("tvd.col.year"), value: String(item.year) });
  const country = countryList(detail?.countries, locale, 1);
  if (country) cols.push({ label: t("tvd.col.country"), value: country });
  if (item.kind === "movie" && detail?.runtime) cols.push({ label: t("tvd.col.runtime"), value: runtimeClock(detail.runtime)! });
  if (item.kind === "series" && detail?.number_of_seasons) cols.push({ label: t("tvd.col.seasons"), value: String(detail.number_of_seasons) });
  for (const r of ratings.slice(0, 2)) cols.push({ label: r.source === "kp" ? "КП" : r.source.toUpperCase(), value: r.value });
  const shown = sources.items.slice(0, 7);
  // One compact fit chip per row: «✓» / «DTS→AAC» / «✗ HEVC» for this TV.
  const caps = useMemo(() => thisTvCaps(), []);
  // With «Смотреть онлайн» too, the row gets compact (and the trailer an icon) so it fits beside the sources table.
  const compact = !!actions.onOnline;
  const btn = `t-label flex h-[70px] shrink-0 items-center whitespace-nowrap ${compact ? "px-[16px] text-[22px]" : "px-[30px] text-[23px]"}`;
  const gap = compact ? "ml-[12px]" : "ml-[18px]";
  return (
    <div className="relative" style={{ height: HEADER_H.terminal }}>
      <p className="t-label absolute left-[96px] top-[52px] text-[21px] text-muted">
        ← {t("tvd.back")}
        {from ? ` · ${from}` : ""}
      </p>
      <p className="t-label absolute right-[96px] top-[52px] text-[21px] text-muted">TMDB/{item.tmdb_id}</p>
      <div className="absolute left-[96px] top-[230px] w-[900px]">
        <h1 className="line-clamp-2 font-display font-extrabold uppercase leading-[1.0]" style={{ fontSize: item.title.length > 22 ? 64 : 88 }}>
          {item.title}
        </h1>
        {detail?.tagline && <p className="t-label mt-6 truncate text-[22px] text-accent">«{detail.tagline.replace(/^[«"]|[»"]$/g, "")}»</p>}
        <div className="t-hair mt-6 flex border-b border-t py-[16px]">
          {cols.slice(0, 4).map((c) => (
            <div key={c.label} className="shrink-0" style={{ width: 220 }}>
              <p className="t-label text-[16px] text-muted">{c.label}</p>
              <p className="mt-2 font-mono text-[27px] text-text">{c.value}</p>
            </div>
          ))}
        </div>
        {/* Extras line → buttons in one group: Up from the buttons reaches «Цитаты»/«Факты», not the sources table. */}
        <FocusBlock focusKey="d-left">
          <ExtrasLine awards={detail?.awards} onAwards={actions.onAwards ?? null} onQuotes={actions.onQuotes ?? null} onFacts={actions.onFacts ?? null} extra={actions.extras} square className="-ml-4 mt-4" />
          <p className="mt-7 line-clamp-3 text-[25px] leading-[1.45] text-text/80">{item.overview || t("catalog.detail.no_overview")}</p>
          <MovieProgress progress={progress} className="mt-5" />
          {/* Own focus group: Down from the buttons goes to the seasons below, not into the sources table on the right. */}
          <FocusBlock focusKey="d-buttons" className="mt-8 flex">
            <FocusButton focusKey="d-play" onPress={actions.onPlay} className={`${btn} bg-accent text-on-accent`}>
              <span className="mr-3">{cv ? <PlayGlyph size={26} /> : "▶"}</span>
              {actions.playLabel}
            </FocusButton>
            {actions.onOnline && (
              <FocusButton focusKey="d-online" onPress={actions.onOnline} className={`${btn} ${gap} border-2 border-accent text-accent`}>
                {t("online.watch")}
              </FocusButton>
            )}
            {actions.onTrailer && (
              <FocusButton focusKey="d-trailer" onPress={actions.onTrailer} className={`${btn} ${gap} border-2 border-text/25`}>
                {compact ? <TrailerIcon size={28} /> : t("tvd.btn.trailer")}
              </FocusButton>
            )}
            {actions.inList !== null && (
              <FocusButton focusKey="d-list" onPress={actions.onList} className={`${btn} ${gap} border-2 ${actions.inList ? "border-accent text-accent" : "border-text/25"}`}>
                {actions.inList ? t("tvd.btn.in_list") : t("tvd.btn.list_add")}
              </FocusButton>
            )}
            <FocusButton focusKey="d-more" onPress={actions.onMore} className={`${btn} ${gap} border-2 border-text/25`}>
              {cv ? <MoreIcon size={30} /> : "⋯"}
            </FocusButton>
          </FocusBlock>
        </FocusBlock>
        {aside && <div className="mt-8">{aside}</div>}
      </div>
      <FocusBlock focusKey="d-src-table" className="absolute right-[96px] top-[466px] w-[800px]">
        <div data-testid="sources-table" data-status={sources.status}>
        <div className="flex items-end justify-between">
          <p className="t-label text-[25px] font-medium text-text">{t("tvd.sources.found", { n: sources.items.length })}</p>
          <p className="t-label text-[17px] text-muted">{t("tvd.sources.order")}</p>
        </div>
        <div className="t-label mt-5 flex px-4 text-[17px] text-muted">
          <span style={{ width: 170 }}>{t("tvd.col.quality")}</span>
          <span className="flex-1">{t("tvd.col.audio_tracker")}</span>
          <span className="text-right" style={{ width: 140 }}>
            {t("tvd.col.size")}
          </span>
          <span className="text-right" style={{ width: 100 }}>
            {t("tvd.col.seeds")}
          </span>
        </div>
        <div className="t-hair mt-3 border-t">
          {sources.status === "loading" || sources.status === "idle" ? (
            <p className="t-label py-6 text-[20px] text-muted tv-pulse">{t("tvd.source.searching")}</p>
          ) : shown.length === 0 ? (
            <div className="py-6">
              <p className="t-label text-[20px] text-muted">{sources.status === "error" ? t("tvd.source.error") : t("tvd.source.none")}</p>
              <FocusButton focusKey="d-refine" onPress={actions.onRefine} className="t-label mt-5 inline-block border-2 border-text/25 px-6 py-3 text-[20px]">
                {t("tv.refine.button")}
              </FocusButton>
            </div>
          ) : (
            shown.map((r, i) => <SourceRow key={r.id} index={i} release={r} best={r.id === sources.best?.id} fit={judgeFit(fitInput(r), caps)} locale={locale} voice={voice} onPress={() => actions.onRelease(r)} />)
          )}
        </div>
        {shown.length > 0 && <p className="t-label mt-5 text-[16px] normal-case tracking-normal text-muted">{t("tvd.sources.note", { profile: profileName })}</p>}
        </div>
      </FocusBlock>
    </div>
  );
}

function SourceRow({
  index,
  release,
  best,
  fit,
  locale,
  voice,
  onPress,
}: {
  index: number;
  release: Release;
  best: boolean;
  fit: Fit;
  locale: string;
  voice: (s: ReleaseSummary) => string | null;
  onPress: () => void;
}) {
  const record = useFocusRecorder();
  const key = `d-src-${index}`;
  const { ref, focused } = useFocusable({ focusKey: key, onEnterPress: onPress, onFocus: () => record?.(key) });
  const s = summarizeRelease(release, locale);
  const tone = focused ? "" : best ? "text-accent" : "text-text";
  return (
    <div
      ref={ref}
      role="button"
      data-source-id={release.id}
      data-best={best ? "1" : undefined}
      onClick={onPress}
      className={`t-row t-hair flex items-center border-b px-4 font-mono text-[22px] ${best && !focused ? "t-row-best" : ""} ${focused ? "is-focused" : ""} ${tone}`}
      style={{ height: 60 }}
    >
      <span className="font-medium" style={{ width: 170 }}>
        {best ? "★ " : ""}
        {s.quality ?? "—"}
        {s.hdr ? <span className="ml-2 text-[16px]">{s.hdr === "Dolby Vision" ? "DV" : "HDR"}</span> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <FitLine fit={fit} compact />
        {[voice(s), s.audio, s.tracker].filter(Boolean).join(" · ")}
      </span>
      <span className="text-right" style={{ width: 140 }}>
        {s.size}
      </span>
      <span className="text-right" style={{ width: 100 }}>
        {s.seeders}
      </span>
    </div>
  );
}

// ================================================================ Проектор (p11)

export function ProjectorBackdrop({ item, cfg, dim }: { item?: MediaSummary; cfg?: CatalogConfig; dim: boolean }) {
  return (
    <div className={`tv-fade absolute left-0 top-0 h-[1080px] w-[1920px] ${dim ? "opacity-40" : "opacity-100"}`}>
      <Backdrop src={imageUrl(cfg, item?.backdrop_path, "w1280")} />
      <div className="p-scrim-left absolute left-0 top-0 h-full w-full" />
      <div className="p-scrim-bottom absolute left-0 top-0 h-full w-full" />
    </div>
  );
}

export function ProjectorHeader({ item, detail, progress, sources, actions, aside }: HeaderProps) {
  const { t, locale } = useI18n();
  const wave = useSkin() === "wireframe";
  const voice = useVoice();
  const ratings = useRatings(item);
  const { main, sub } = splitTitle(item.title);
  const who = people(item, detail)[0];
  const meta = [...useMeta(item, detail), ...ratings.map((r) => `${RATING_LABEL[r.source]} ${r.value}`)];
  const s = sources.best ? summarizeRelease(sources.best, locale) : null;
  const badges = s ? [s.badge, s.hdr, s.audio === "Atmos" ? "ATMOS" : null, voice(s)].filter((x): x is string => !!x) : [];
  const pill = "flex h-[72px] shrink-0 items-center whitespace-nowrap rounded-full px-[38px] text-[27px] font-medium";
  const k = useTitleScale();
  return (
    <div className="relative" style={{ height: HEADER_H.projector }}>
      <div className="absolute left-[96px] top-[210px] w-[1100px]">
        <p className="truncate text-[20px] font-bold uppercase tracking-[.18em] text-accent">
          {t(`catalog.kind.${item.kind}`)}
          {who ? ` · ${who}` : ""}
        </p>
        <h1 className="mt-3 text-white">
          <span className="p-wide line-clamp-2 block font-bold uppercase leading-[1.04]" style={{ fontSize: Math.round((main.length > 18 ? 64 : main.length > 9 ? 84 : 110) * k) }}>
            {main}
          </span>
          {sub && <span className="mt-1 block truncate text-[40px] font-medium uppercase leading-tight tracking-[.24em] text-white/90">{sub}</span>}
        </h1>
        <p className="mt-6 truncate text-[25px] text-white/90">{meta.join("  ·  ")}</p>
        <ExtrasLine awards={detail?.awards} onAwards={actions.onAwards ?? null} onQuotes={actions.onQuotes ?? null} onFacts={actions.onFacts ?? null} extra={actions.extras} className="-ml-4 mt-3 text-white/90" />
        {badges.length > 0 && (
          <div data-testid="release-badges" className="mt-5 flex">
            {badges.map((b) => (
              <span key={b} className="p-outline mr-3 rounded-[8px] px-3 text-[19px] font-bold uppercase leading-[34px] text-white">
                {b}
              </span>
            ))}
          </div>
        )}
        <p className="mt-6 line-clamp-3 w-[760px] text-[25px] leading-[1.45] text-white/85">{item.overview || t("catalog.detail.no_overview")}</p>
        <MovieProgress progress={progress} className="mt-5" />
        <div className="mt-9 flex items-center">
          <FocusButton focusKey="d-play" onPress={actions.onPlay} className={`${pill} p-primary bg-white text-black`}>
            <span className="mr-4 text-[22px]">▶</span>
            {actions.playLabel}
          </FocusButton>
          {actions.onOnline && (
            <FocusButton focusKey="d-online" onPress={actions.onOnline} className={`${pill} p-glass ml-5`}>
              {t("online.watch")}
            </FocusButton>
          )}
          {actions.onTrailer && (
            <FocusButton focusKey="d-trailer" onPress={actions.onTrailer} className={`${pill} p-glass ml-5`}>
              {t("tvd.btn.trailer")}
            </FocusButton>
          )}
          <FocusButton focusKey="d-sources" onPress={actions.onSources} className={`${pill} p-glass ml-5`}>
            {t("tvd.btn.sources")}
          </FocusButton>
          {actions.inList !== null && (
            <FocusButton focusKey="d-list" onPress={actions.onList} className="p-glass ml-5 flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-full">
              {wave ? actions.inList ? <WaveCheckIcon size={30} stroke={2.4} /> : <WavePlusIcon size={30} stroke={2.4} /> : actions.inList ? <CheckIcon size={30} stroke={2.4} /> : <PlusIcon size={30} stroke={2.4} />}
            </FocusButton>
          )}
          <FocusButton focusKey="d-more" onPress={actions.onMore} className="p-glass ml-5 flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-full">
            {wave ? <WaveMoreIcon size={30} /> : <MoreIcon size={30} />}
          </FocusButton>
        </div>
      </div>
      {aside && <div className="absolute right-[96px] top-[600px] w-[560px]">{aside}</div>}
    </div>
  );
}

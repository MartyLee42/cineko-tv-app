// Home's hero (follows the focused card) in each design.
import type { CatalogConfig, ContinueItem, MediaDetail, MediaSummary } from "@martytv/contracts";
import { imageUrl, placeholderColor } from "@martytv/media-types";
import { useI18n } from "@martytv/ui";
import { Backdrop, Img, legacyColor } from "../components/Img";
import { useSettings } from "../profile/settings";
import { barFraction, formatLeft, timeLeft } from "../watch/resume";
import { usePlural } from "./context";
import { filledSegments, RATING_LABEL, ratingList, remainingClock, rulerMarks, runtimeClock } from "./format";
import { Brackets } from "./cards";
import { StatusCorner } from "./shell";
import { HeroEdges, useTitleScale } from "./skins";
import type { Recommendation } from "./data";

/** The overview, or the recommender's note for a recommended title. */
function overviewOf(d: HeroData): string {
  return d.reco?.note ? `«${d.reco.note}»` : d.item.overview;
}

export interface HeroData {
  item: MediaSummary;
  /** Full details once loaded (seasons, runtime, genres). */
  detail?: MediaDetail;
  cont?: ContinueItem;
  /** «Советуют близкие»: who recommended it (the note replaces the overview). */
  reco?: Recommendation;
  /** «Для вас»: why it's recommended (replaces the eyebrow). */
  reason?: string;
  /** Title of the row the item is in. */
  row: string;
  rowIndex: number;
  /** Genre names for the item (from the genre lists). */
  genres: string[];
}

/** Episode code / time left / bar of a "Continue watching" item. */
export function useContinueInfo(cont: ContinueItem | undefined) {
  const { t, locale } = useI18n();
  if (!cont) return null;
  const p = cont.progress && !cont.progress.completed ? cont.progress : null;
  const n = cont.next_up;
  const s = p?.season_number ?? n?.season_number ?? null;
  const e = p?.episode_number ?? n?.episode_number ?? null;
  const code = s !== null && e !== null ? t("tvd.ep", { s, e }) : null;
  const short = s !== null && e !== null ? t("tvd.ep_short", { s, e }) : null;
  const left = p ? timeLeft(p) : null;
  const frac = p ? barFraction(p.percent) : null;
  const name = !p && n ? n.name : null;
  let line: string | null = null;
  if (left !== null) {
    const l = formatLeft(left, locale);
    line = code ? (name ? t("tvd.hero.left_episode", { code, name, left: l }) : `${code} — ${t("tvd.hero.left", { left: l })}`) : t("tvd.hero.left", { left: l });
  } else if (code) line = name ? `${code} «${name}»` : code;
  return { code, short, left, frac, line, nextUp: !p && !!n, s, e };
}

function eyebrow(d: HeroData, t: ReturnType<typeof useI18n>["t"], cont: ReturnType<typeof useContinueInfo>): string {
  const kind = t(`catalog.kind.${d.item.kind}`);
  if (cont) return `${kind} · ${cont.nextUp ? t("tvd.eyebrow.next_up") : t("tvd.eyebrow.watching")}`;
  if (d.reco) return `${kind} · ${t("reco.from", { name: d.reco.from.name })}`;
  if (d.reason) return d.reason;
  // Not the row title: the row header right below already says it.
  return [kind, d.genres[0]].filter(Boolean).join(" · ");
}

function titleSize(title: string, sizes: [number, number, number]): number {
  return title.length > 26 ? sizes[2] : title.length > 15 ? sizes[1] : sizes[0];
}

/** Ratings known for the item, primary (poster setting) first. */
function useRatings(item: MediaSummary) {
  const setting = useSettings().poster_rating;
  return ratingList(item, setting === "off" ? "kp" : setting);
}

// ================================================================ Кинозал

export function KinozalHero({ data, cfg, loading }: { data: HeroData | null; cfg: CatalogConfig | undefined; loading: boolean }) {
  const { t } = useI18n();
  const plural = usePlural();
  const cont = useContinueInfo(data?.cont);
  const item = data?.item;
  const ratings = useRatings(item ?? ({ rating: null } as MediaSummary));
  const seasons = data?.detail?.number_of_seasons;
  const meta = item
    ? [item.year ? String(item.year) : null, data!.genres.slice(0, 3).join(", ") || null, item.kind === "series" && seasons ? plural("tvd.seasons", seasons) : null].filter(
        (x): x is string => !!x,
      )
    : [];
  return (
    <>
      <div className="absolute top-0" style={{ left: 600, width: 1320, height: 690 }}>
        <Backdrop src={imageUrl(cfg, item?.backdrop_path, "w1280")} />
        <div className="k-fade-left absolute left-0 top-0 h-full w-full" />
        <div className="k-fade-bottom absolute left-0 top-0 h-full w-full" />
        <HeroEdges height={690} />
      </div>
      <StatusCorner className="absolute right-[96px] top-[52px]" />
      <div data-testid="hero" className="absolute left-[168px] top-[128px] w-[1000px]">
        {loading || !item ? (
          <>
            <div className="h-6 w-[300px] rounded bg-surface-2 tv-pulse" />
            <div className="mt-6 h-20 w-[640px] rounded-xl bg-surface-2 tv-pulse" />
            <div className="mt-8 h-24 w-[780px] rounded-lg bg-surface tv-pulse" />
          </>
        ) : (
          <>
            <p className="truncate text-[21px] font-bold uppercase tracking-[.16em] text-accent">{eyebrow(data!, t, cont)}</p>
            <h2 className="mt-3 truncate font-bold leading-[1.12] tracking-[-.02em]" style={{ fontSize: titleSize(item.title, [86, 70, 56]) }}>
              {item.title}
            </h2>
            <div className="mt-4 flex items-center text-[26px] text-text/85">
              <RatingRow ratings={ratings} />
              {meta.map((m, i) => (
                <span key={i} className="flex items-center whitespace-nowrap">
                  {(i > 0 || ratings.length > 0) && <span className="mx-[14px] text-[18px] text-muted">•</span>}
                  <span className={i === 1 ? "truncate" : ""}>{m}</span>
                </span>
              ))}
            </div>
            <p className="mt-5 line-clamp-3 w-[800px] text-[25px] leading-[1.45] text-text/70">{overviewOf(data!)}</p>
            {cont && (cont.frac !== null || cont.line) && (
              <div data-testid="hero-progress" className="mt-6 flex items-center">
                {cont.frac !== null && (
                  <span className="k-track relative mr-7 inline-block h-[6px] w-[330px] overflow-hidden rounded-full">
                    <span className="absolute left-0 top-0 h-full w-full rounded-full bg-accent" style={{ transform: `scaleX(${cont.frac})`, transformOrigin: "0 0" }} />
                  </span>
                )}
                {cont.line && <span className="truncate text-[24px] text-text/80">{cont.line}</span>}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** "[КП 8.5] IMDb 8.7 · TMDB 8.2": the primary in the PDF's white badge. */
export function RatingRow({ ratings, size = "md" }: { ratings: { source: "kp" | "imdb" | "tmdb"; value: string }[]; size?: "md" | "lg" }) {
  if (ratings.length === 0) return null;
  const [first, ...rest] = ratings;
  return (
    <span data-testid="ratings" className="flex items-center whitespace-nowrap">
      <span className={`k-badge rounded-[7px] px-[9px] font-bold ${size === "lg" ? "text-[24px] leading-[38px]" : "text-[22px] leading-[34px]"}`}>
        {RATING_LABEL[first!.source]} {first!.value}
      </span>
      {rest.map((r) => (
        <span key={r.source} className="ml-[14px]">
          {RATING_LABEL[r.source]} {r.value}
        </span>
      ))}
    </span>
  );
}

// ================================================================ Терминал

export function TerminalHero({ data, cfg, loading }: { data: HeroData | null; cfg: CatalogConfig | undefined; loading: boolean }) {
  const { t, locale } = useI18n();
  const cont = useContinueInfo(data?.cont);
  const item = data?.item;
  const d = data?.detail;
  const ratings = useRatings(item ?? ({ rating: null } as MediaSummary));
  const kind = item ? t(`catalog.kind.${item.kind}`) : "";
  const brow = !data
    ? ""
    : cont
      ? [`▸ ${t("tvd.eyebrow.continue")}`, kind, cont.short].filter(Boolean).join(" · ")
      : data.reco
        ? `▸ ${data.reco.from.name} → ${kind}`
        : data.reason
          ? `▸ ${data.reason}`
          : `▸ ${[kind, ...data.genres.slice(0, 2)].join(" · ")}`;
  const cols: { label: string; value: string }[] = [];
  if (item?.year) cols.push({ label: t("tvd.col.year"), value: String(item.year) });
  for (const r of ratings.slice(0, 2)) cols.push({ label: r.source === "kp" ? "КП" : r.source.toUpperCase(), value: r.value });
  if (cont?.left !== null && cont?.left !== undefined) cols.push({ label: t("tvd.col.left"), value: remainingClock(cont.left) ?? "—" });
  else if (item?.kind === "series" && d?.number_of_seasons) cols.push({ label: t("tvd.col.seasons"), value: String(d.number_of_seasons) });
  else if (d?.runtime) cols.push({ label: t("tvd.col.runtime"), value: runtimeClock(d.runtime)! });
  if (d?.original_language) cols.push({ label: t("tvd.col.sound"), value: d.original_language.toUpperCase() });
  const pct = cont?.frac !== null && cont?.frac !== undefined ? cont.frac * 100 : null;
  const segs = filledSegments(cont?.frac ?? null, 40);
  const code = cont && cont.s !== null && cont.e !== null ? ` · S${String(cont.s).padStart(2, "0")}E${String(cont.e).padStart(2, "0")}` : "";
  void locale;
  return (
    <>
      {item && (
        <>
          <span className="t-label absolute right-[150px] top-[140px] text-[17px] text-muted">
            TMDB/{item.tmdb_id}
            {code}
          </span>
          <div className="absolute" style={{ left: 1392, top: 182, width: 370, height: 555 }}>
            <div className="relative h-full w-full overflow-hidden" style={{ background: legacyColor(placeholderColor(item.id)) }}>
              <Img src={imageUrl(cfg, item.poster_path, "w500")} className="absolute left-0 top-0 h-full w-full object-cover" />
            </div>
            <Brackets />
          </div>
          <div className="absolute font-mono text-[15px]" style={{ left: 1806, top: 182, height: 555 }}>
            {rulerMarks(pct).map((m) => (
              <span key={m.value} className={`absolute left-0 ${m.current ? "text-accent" : "text-muted/70"}`} style={{ top: (m.value / 99) * 535 }}>
                {m.label}
              </span>
            ))}
          </div>
        </>
      )}
      <div data-testid="hero" className="absolute left-[96px] top-[176px] w-[1180px]">
        {loading || !item ? (
          <>
            <div className="h-6 w-[360px] bg-surface-2 tv-pulse" />
            <div className="mt-6 h-24 w-[760px] bg-surface-2 tv-pulse" />
          </>
        ) : (
          <>
            <p className="t-label truncate text-[22px] text-accent">{brow}</p>
            <h2 className="mt-5 line-clamp-2 font-display font-extrabold uppercase leading-[1.02]" style={{ fontSize: titleSize(item.title, [104, 76, 58]) }}>
              {item.title}
            </h2>
            <div className="t-hair mt-7 flex border-b border-t py-[18px]" style={{ width: 1050 }}>
              {cols.slice(0, 5).map((c) => (
                <div key={c.label} className="shrink-0" style={{ width: 210 }}>
                  <p className="t-label text-[16px] text-muted">{c.label}</p>
                  <p className="mt-2 font-mono text-[27px] text-text">{c.value}</p>
                </div>
              ))}
            </div>
            {cont?.frac !== null && cont?.frac !== undefined && (
              <div data-testid="hero-progress" className="mt-7 flex h-[9px]">
                {Array.from({ length: 40 }, (_, i) => (
                  <span key={i} className={`mr-[5px] h-full w-[15px] ${i < segs ? "t-seg-on" : "t-seg"}`} />
                ))}
              </div>
            )}
            <p className="mt-7 line-clamp-2 w-[820px] text-[25px] leading-[1.45] text-text/75">{overviewOf(data!)}</p>
          </>
        )}
      </div>
    </>
  );
}

// ================================================================ Проектор

export function ProjectorHero({
  data,
  cfg,
  loading,
  children,
}: {
  data: HeroData | null;
  cfg: CatalogConfig | undefined;
  loading: boolean;
  /** The focusable action buttons. */
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const cont = useContinueInfo(data?.cont);
  const item = data?.item;
  const ratings = useRatings(item ?? ({ rating: null } as MediaSummary));
  const meta = item ? [item.year ? String(item.year) : null, data!.genres.slice(0, 2).join(", ") || null, ...ratings.slice(0, 1).map((r) => `${RATING_LABEL[r.source]} ${r.value}`)].filter((x): x is string => !!x) : [];
  const k = useTitleScale();
  return (
    <>
      <div className="absolute left-0 top-0 h-[1080px] w-[1920px]">
        <Backdrop src={imageUrl(cfg, item?.backdrop_path, "w1280")} />
        <div className="p-scrim-left absolute left-0 top-0 h-full w-full" />
        <div className="p-scrim-bottom absolute left-0 top-0 h-full w-full" />
        <HeroEdges height={1080} />
      </div>
      <div data-testid="hero" className="absolute bottom-[404px] left-[96px] w-[1300px]">
        {loading || !item ? (
          <div className="h-28 w-[700px] rounded-2xl bg-white/10 tv-pulse" />
        ) : (
          <>
            <p className="truncate text-[20px] font-bold uppercase tracking-[.18em] text-accent">{eyebrow(data!, t, cont)}</p>
            <h2 className="p-wide mt-3 line-clamp-2 font-bold uppercase leading-[1.05] text-white" style={{ fontSize: Math.round(titleSize(item.title, [128, 84, 64]) * k) }}>
              {item.title}
            </h2>
            <p className="mt-6 truncate text-[27px] text-white/90">{meta.join("  ·  ")}</p>
            <div className="mt-8 flex">{children}</div>
          </>
        )}
      </div>
    </>
  );
}

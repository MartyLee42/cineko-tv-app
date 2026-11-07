// Cards per design. Focus is owned by the row/grid slot; these only draw.
import type { CatalogConfig, MediaSummary } from "@martytv/contracts";
import { imageUrl, placeholderColor } from "@martytv/media-types";
import { Img, legacyColor } from "../components/Img";
import { ProgressBar, WatchBadges } from "../components/Poster";
import { useSettings } from "../profile/settings";
import { awardBadgeTitle, hasQualityMark, QualityMark, udarnikLabel, useAppliedDesign, useI18n } from "@martytv/ui";
import { useDesign, type Design } from "./context";
import { indexTag, posterBadge, type RatingsInput } from "./format";
import { stickerOf } from "./sticker";

/** The rating badge in a card's top-right corner (hidden when unknown / off). */
export function RatingBadge({ item, design }: { item: RatingsInput; design: Design }) {
  const setting = useSettings().poster_rating;
  const b = posterBadge(item, setting);
  const cv = useAppliedDesign() === "constructivism";
  // «Конструктивизм»: «Знак качества» on ≥ 8.5 (КП or TMDB), «ударник ★…» on high ratings.
  const quality = cv && hasQualityMark([item.kp_rating, item.rating]);
  const mark = quality ? <QualityMark size={46} className="absolute bottom-2 right-2" /> : null;
  if (!b) return mark;
  if (design === "terminal") {
    const udarnik = cv ? udarnikLabel(Number(b.text)) : null;
    // «ударник ★…»: a red slab along the poster's bottom-left edge (clear of the ✓/♥ marks
    // top-left); «Знак качества» then stands above it, bottom-right.
    if (udarnik)
      return (
        <>
          <span data-rating={b.text} data-rating-source={b.source} data-udarnik className="t-tag cv-udarnik absolute bottom-0 left-0">
            {udarnik}
          </span>
          {quality && <QualityMark size={46} className="absolute bottom-[38px] right-2" />}
        </>
      );
    return (
      <>
        <span data-rating={b.text} data-rating-source={b.source} className={`t-tag tv-rate-t-${b.tone} absolute right-0 top-0 px-2 py-0.5 font-mono text-[17px] leading-tight`}>
          {b.text}
        </span>
        {mark}
      </>
    );
  }
  if (design === "projector") {
    return (
      <span data-rating={b.text} data-rating-source={b.source} className="tv-rate-chip absolute right-3 top-3 rounded-lg px-2 text-[18px] font-bold leading-[28px]">
        {b.text}
      </span>
    );
  }
  return (
    <span data-rating={b.text} data-rating-source={b.source} className={`tv-rate-${b.tone} absolute right-2 top-2 rounded-full px-2.5 text-[19px] font-bold leading-[30px] shadow`}>
      {b.text}
    </span>
  );
}

/** 🏆 under the rating badge for tier-1 award wins (MediaSummary.award_badge): «🏆» or «🏆3». */
export function AwardMark({ item, design }: { item: Pick<MediaSummary, "award_badge">; design: Design }) {
  const { t } = useI18n();
  const b = item.award_badge;
  if (!b) return null;
  const pos = design === "terminal" ? "t-tag right-0 top-[30px] px-2 text-[17px] leading-tight" : design === "projector" ? "tv-rate-chip right-3 top-[46px] rounded-lg px-2 text-[18px] leading-[28px]" : "right-2 top-[48px] rounded-full bg-black/70 px-2 text-[18px] leading-[28px] text-white shadow";
  return (
    <span data-award-badge={b.group} title={awardBadgeTitle(b, t)} className={`absolute font-bold ${pos}`}>
      🏆{b.count > 1 ? b.count : ""}
    </span>
  );
}

/** Orange corner brackets around a focused Терминал card. */
export function Brackets({ small }: { small?: boolean }) {
  const s = small ? " t-bracket-sm" : "";
  return (
    <>
      <span className={`t-bracket t-bracket-tl${s}`} />
      <span className={`t-bracket t-bracket-tr${s}`} />
      <span className={`t-bracket t-bracket-bl${s}`} />
      <span className={`t-bracket t-bracket-br${s}`} />
    </>
  );
}

/** A 2:3 poster card in the design's style (title under it when `showTitle`). */
export function PosterCard({
  item,
  cfg,
  width,
  height,
  focused,
  index,
  showTitle,
  overlay,
}: {
  item: MediaSummary;
  cfg: CatalogConfig | undefined;
  width: number;
  height: number;
  focused: boolean;
  /** Терминал: the mono index tag (1-based). */
  index?: number;
  showTitle?: boolean;
  /** Drawn over the image's top-left (a sender chip); replaces Терминал's index tag. */
  overlay?: React.ReactNode;
}) {
  const design = useDesign();
  const square = design === "terminal";
  return (
    <div style={{ width }} data-card-id={item.id} data-sticker={stickerOf(item.id)} className={focused ? "mt-hop" : undefined}>
      <div className="relative" style={{ width, height }}>
        <div
          className={`tv-focus mt-card relative overflow-hidden ${square ? "" : "rounded-card"} ${focused ? "is-focused" : ""}`}
          style={{ width, height, background: legacyColor(placeholderColor(item.id)) }}
        >
          {/* Placeholder: visible until the poster loads, and if it never does. */}
          <div className="absolute bottom-0 left-0 right-0 p-4">
            <p className="line-clamp-4 text-2xl font-bold leading-tight text-white">{item.title}</p>
            {item.year && <p className="mt-1 text-xl text-white/70">{item.year}</p>}
          </div>
          <Img src={imageUrl(cfg, item.poster_path, "w342")} className="absolute left-0 top-0 h-full w-full object-cover" />
          {overlay}
          {!overlay && square && index !== undefined && (
            <span className={`t-tag absolute left-0 top-0 px-2 py-0.5 font-mono text-[17px] leading-tight ${focused ? "text-accent" : "text-text/80"}`}>{indexTag(index)}</span>
          )}
          <RatingBadge item={item} design={design} />
          <AwardMark item={item} design={design} />
          <WatchBadges me={item.me} top={square && !overlay && index !== undefined ? 40 : 12} />
        </div>
        {square && focused && <Brackets small />}
      </div>
      {showTitle && <CardCaption design={design} focused={focused} title={item.title} sub={item.year ? String(item.year) : null} year />}
    </div>
  );
}

/** `year`: `sub` is the release year (Вестерн prints it as the bill's reward). */
function CardCaption({ design, focused, title, sub, year }: { design: Design; focused: boolean; title: string; sub?: string | null; year?: boolean }) {
  if (design === "terminal") {
    return <p className={`t-label mt-3 truncate text-[17px] ${focused ? "text-text" : "text-muted"}`}>{title}</p>;
  }
  return (
    <>
      <p className={`mt-3 truncate text-[22px] leading-tight ${focused ? "font-bold text-text" : "text-text/85"}`}>{title}</p>
      {sub && (
        <p data-year={year ? "" : undefined} className="mt-1 truncate text-[18px] text-muted">
          {sub}
        </p>
      )}
    </>
  );
}

/**
 * A 16:9 card (backdrop): Кинозал/Терминал put the title under it,
 * Проектор overlays it on the image. `progress` draws the watch bar.
 */
export function WideCard({
  media,
  title,
  sub,
  progress,
  cfg,
  width,
  height,
  focused,
  index,
  badge,
  overlay,
}: {
  media: MediaSummary;
  title: string;
  sub?: string | null;
  progress?: number | null;
  cfg: CatalogConfig | undefined;
  width: number;
  height: number;
  focused: boolean;
  index?: number;
  /** A corner label (e.g. "Next up"). */
  badge?: string | null;
  overlay?: React.ReactNode;
}) {
  const design = useDesign();
  const img = imageUrl(cfg, media.backdrop_path ?? media.poster_path, "w780");
  // Rows that pass progress (Continue) own the bar; elsewhere it comes from the profile's state.
  const frac = progress !== undefined ? progress : null;
  const marks = !badge && !overlay ? <WatchBadges me={media.me} progress={progress === undefined} /> : null;
  if (design === "projector") {
    return (
      <div style={{ width }} data-card-id={media.id} className={focused ? "mt-hop" : undefined}>
        <div
          className={`tv-focus mt-card relative overflow-hidden rounded-card ${focused ? "is-focused" : ""}`}
          style={{ width, height, background: legacyColor(placeholderColor(media.id)) }}
        >
          <Img src={img} className="absolute left-0 top-0 h-full w-full object-cover" />
          <div className="p-card-shade absolute left-0 top-0 h-full w-full" />
          {overlay}
          <RatingBadge item={media} design={design} />
          <AwardMark item={media} design={design} />
          {badge && <span className="tv-check absolute left-4 top-4 rounded-full px-4 py-1 text-[18px] font-bold">{badge}</span>}
          {marks}
          <p className="absolute bottom-7 left-6 right-6 truncate text-[26px] font-bold text-white">
            {title}
            {sub ? <span className="font-medium text-white/80"> · {sub}</span> : null}
          </p>
          {frac !== null && (
            <span className="absolute bottom-4 left-6 right-6 h-[5px] overflow-hidden rounded-full bg-white/30">
              <span data-progress={Math.round(frac * 100)} className="absolute left-0 top-0 h-full w-full rounded-full bg-white" style={{ transform: `scaleX(${frac})`, transformOrigin: "0 0" }} />
            </span>
          )}
        </div>
      </div>
    );
  }
  const square = design === "terminal";
  return (
    <div style={{ width }} data-card-id={media.id} data-sticker={stickerOf(media.id)} className={focused ? "mt-hop" : undefined}>
      <div className="relative" style={{ width, height }}>
        <div
          className={`tv-focus mt-card relative overflow-hidden ${square ? "" : "rounded-card"} ${focused ? "is-focused" : ""}`}
          style={{ width, height, background: legacyColor(placeholderColor(media.id)) }}
        >
          <p className="absolute bottom-6 left-5 right-5 line-clamp-2 text-2xl font-bold text-white">{title}</p>
          <Img src={img} className="absolute left-0 top-0 h-full w-full object-cover" />
          {overlay}
          {!overlay && square && index !== undefined && <span className="t-tag absolute left-0 top-0 px-2 py-0.5 font-mono text-[17px] text-accent">{indexTag(index)}</span>}
          <RatingBadge item={media} design={design} />
          <AwardMark item={media} design={design} />
          {badge && <span className="tv-check absolute bottom-4 right-3 rounded-full px-4 py-1 text-[18px] font-bold">{badge}</span>}
          {marks}
          {frac !== null && <ProgressBar fraction={frac} className="h-[6px]" />}
        </div>
        {square && focused && <Brackets small />}
      </div>
      <CardCaption design={design} focused={focused} title={title} sub={sub} />
    </div>
  );
}

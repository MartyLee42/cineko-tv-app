// «Видео» cards per design: a 16:9 thumbnail (duration / ЭФИР / Shorts badge,
// the watch bar), the title, the channel and «1,2 млн просмотров · 3 дня
// назад». Focus is owned by the row/grid slot; these only draw.
// Old engines: no aspect-ratio / inset / gap — fixed sizes and margins.
import { memo, useMemo, useState } from "react";
import { useI18n, type MessageKey } from "@martytv/ui";
import { placeholderColor } from "@martytv/media-types";
import { Img, legacyColor } from "../components/Img";
import { ProgressBar } from "../components/Poster";
import { Brackets } from "../design/cards";
import { useDesign, type Design } from "../design/context";
import { ago, compactCount, countForm, formatDuration, progressFraction, type VideoItem } from "./logic";

/** Card geometry per design (thumbnail + caption). */
export interface VideoGeo {
  w: number;
  h: number;
  caption: number;
  gap: number;
}

const GEO_TERMINAL: VideoGeo = { w: 352, h: 198, caption: 92, gap: 22 };
const GEO_PROJECTOR: VideoGeo = { w: 400, h: 225, caption: 104, gap: 30 };
const GEO: VideoGeo = { w: 384, h: 216, caption: 104, gap: 28 };

/** Stable objects per design (cards are memoized on them). */
export function videoGeo(design: Design): VideoGeo {
  if (design === "terminal") return GEO_TERMINAL;
  if (design === "projector") return GEO_PROJECTOR;
  return GEO;
}

/** «1,2 млн просмотров · 3 дня назад» in the current locale. */
export function useVideoMeta() {
  const { t, locale } = useI18n();
  const [now] = useState(() => Date.now());
  return useMemo(() => {
    const views = (n: number | null | undefined) => (n === null || n === undefined ? null : t(`video.tv.views.${countForm(n, locale)}` as MessageKey, { n: compactCount(n, locale) }));
    const when = (iso: string | null | undefined) => {
      const a = ago(iso, now);
      if (!a) return null;
      if (a.unit === "now") return t("video.tv.ago.now");
      return t(`video.tv.ago.${a.unit}.${countForm(a.n, locale)}` as MessageKey, { n: a.n });
    };
    return {
      views,
      when,
      line: (v: Pick<VideoItem, "views" | "published_at" | "live">) => [views(v.views), v.live ? null : when(v.published_at)].filter(Boolean).join(" · "),
    };
  }, [t, locale, now]);
}

/** The thumbnail with its badges (also used by the player's panel). */
export function VideoThumb({ v, w, h, design, focused, className = "" }: { v: VideoItem; w: number; h: number; design: Design; focused: boolean; className?: string }) {
  const { t } = useI18n();
  const dur = formatDuration(v.duration_seconds);
  const frac = progressFraction(v.progress, v.duration_seconds);
  const corners = design === "terminal" ? "" : design === "projector" ? "rounded-[22px]" : "rounded-card";
  return (
    <div
      className={`tv-focus mt-card relative overflow-hidden ${corners} ${focused ? "is-focused" : ""} ${className}`}
      style={{ width: w, height: h, background: legacyColor(placeholderColor(v.id)) }}
    >
      <Img src={w > 340 ? v.thumbnail_hd : v.thumbnail} className="absolute left-0 top-0 h-full w-full object-cover" />
      {v.live ? (
        <span data-testid="video-live" className="absolute bottom-3 right-3 rounded bg-danger px-2 text-[18px] font-bold uppercase leading-[28px] text-bg">
          {t("video.live")}
        </span>
      ) : (
        dur && (
          <span data-testid="video-duration" className={`v-badge absolute bottom-3 right-3 px-2 text-[19px] font-semibold leading-[28px] text-white ${design === "terminal" ? "font-mono" : "rounded"}`}>
            {dur}
          </span>
        )
      )}
      {v.short && !v.live && <span className="v-badge absolute left-3 top-3 rounded px-2 text-[17px] font-semibold leading-[26px] text-white">{t("video.short")}</span>}
      {frac !== null && <ProgressBar fraction={frac} className="h-[6px]" />}
    </div>
  );
}

/** Memoized: a key press re-renders the row, but only the two cards whose focus changed redraw. */
export const VideoCard = memo(function VideoCard({ v, focused, g, index }: { v: VideoItem; focused: boolean; g: VideoGeo; index?: number }) {
  const design = useDesign();
  const meta = useVideoMeta();
  const terminal = design === "terminal";
  const line = meta.line(v);
  return (
    <div data-video-id={v.id} data-testid="video-card" style={{ width: g.w }}>
      <div className="relative" style={{ width: g.w, height: g.h }}>
        <VideoThumb v={v} w={g.w} h={g.h} design={design} focused={focused} />
        {terminal && index !== undefined && <span className="t-tag absolute left-0 top-0 px-2 py-0.5 font-mono text-[17px] text-accent">{String(index).padStart(2, "0")}</span>}
        {terminal && focused && <Brackets small />}
      </div>
      <div style={{ height: g.caption }}>
        <p
          data-testid="video-title"
          className={`mt-3 line-clamp-2 leading-tight ${terminal ? "t-label text-[18px]" : "text-[22px]"} ${focused ? "font-bold text-text" : "text-text/85"}`}
        >
          {v.title}
        </p>
        <p className={`mt-1 truncate text-muted ${terminal ? "font-mono text-[15px]" : "text-[18px]"}`}>
          {v.channel_name}
          {v.channel_verified ? " ✓" : ""}
          {line ? ` · ${line}` : ""}
        </p>
      </div>
    </div>
  );
});

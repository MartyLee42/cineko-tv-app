// «Конструктивизм» pieces on TV screens: the «Рекомендуем к просмотру» card
// for «Ленин в Октябре» (Home's first row) and the «VOICE OF AMERICA»
// banner over «Видео». Static shapes; focus = the design's frame.
import type { CatalogConfig, MediaSummary } from "@martytv/contracts";
import { imageUrl } from "@martytv/media-types";
import { SovietEmblem, useI18n } from "@martytv/ui";
import { Img } from "../components/Img";

/** Width of the card (its row holds this one card). */
export const LENIN_CARD_W = 920;

export function LeninCard({ media, cfg, height, focused }: { media: MediaSummary; cfg: CatalogConfig | undefined; height: number; focused: boolean }) {
  const { t } = useI18n();
  const grot = "var(--mt-font-display)";
  const posterW = Math.round((height * 2) / 3);
  return (
    <div data-card-id={media.id} data-testid="cv-lenin" style={{ width: LENIN_CARD_W }} className={focused ? "mt-hop" : undefined}>
      <div className={`cv-lenin tv-focus relative flex overflow-hidden ${focused ? "is-focused" : ""}`} style={{ width: LENIN_CARD_W, height }}>
        <div className="relative shrink-0 bg-[#1a1512]" style={{ width: posterW, height }}>
          <Img src={imageUrl(cfg, media.poster_path, "w342")} className="absolute left-0 top-0 h-full w-full object-cover" />
        </div>
        <div className="relative min-w-0 flex-1 py-5 pl-8 pr-[190px]">
          <p className="inline-block bg-[#1a1512] px-3 py-0.5 text-[20px] font-bold uppercase tracking-[.18em] text-[#efe4cc]" style={{ fontFamily: grot }}>
            {t("designs.constructivism.recommend")}
          </p>
          <p className="mt-3 line-clamp-2 text-[50px] font-bold uppercase leading-[1.02]" style={{ fontFamily: grot }}>
            {media.title}
          </p>
          <p className="mt-2 line-clamp-2 text-[20px] leading-snug text-[#f8f0de]/85">{t("designs.constructivism.recommend_hint")}</p>
        </div>
        <div className="cv-lenin-wedge absolute right-0 top-0 h-full w-[230px]" />
        <SovietEmblem size={120} className="absolute right-[34px]" style={{ top: Math.round((height - 120) / 2) }} />
      </div>
    </div>
  );
}

/** «VOICE OF AMERICA» over «Видео» (decorative: never focused, no layout room taken). */
export function VoiceOfAmerica() {
  return (
    <div data-testid="cv-voa" aria-hidden className="cv-voa pointer-events-none absolute right-[90px] top-[26px] px-8 pb-2 pt-1 text-[72px] font-bold uppercase leading-[1.05] tracking-[.04em]">
      Voice of America
    </div>
  );
}

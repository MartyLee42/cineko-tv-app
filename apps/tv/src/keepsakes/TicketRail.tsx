// «Моё» keepsakes (lazy chunk with the shared ticket/sticker art): a row of
// ticket stubs (remote-navigable, OK opens the film) and the earned stickers.
import type { AchievementList, MediaSummary, TicketPage } from "@martytv/contracts";
import { imageUrl } from "@martytv/media-types";
import { useI18n } from "@martytv/ui";
import { countKey, knownStickers, secretKey, StickerCard, TicketCard } from "@martytv/ui/keepsakes";
import { HRow } from "../components/HRow";
import { useCatalogConfig } from "../catalog/queries";
import { KEEP_LABEL, KEEP_STICKERS, TICKET_FONT, TICKET_H, TICKET_W } from "./data";

export function TicketRail({
  page,
  achievements,
  viewport,
  initialIndex,
  onIndexChange,
  onOpen,
}: {
  page: TicketPage | undefined;
  achievements: AchievementList | undefined;
  viewport: number;
  initialIndex: number;
  onIndexChange: (i: number) => void;
  onOpen: (m: MediaSummary) => void;
}) {
  const { t, locale } = useI18n();
  const cfg = useCatalogConfig();
  const tickets = page?.items ?? [];
  const stickers = knownStickers(achievements?.items ?? []);
  const more = page ? page.total - tickets.length : 0;
  const secret = achievements ? secretKey(locale, achievements.secret) : null;
  return (
    <div data-testid="mine-keepsakes">
      {tickets.length > 0 && page && (
        <>
          <div className="flex items-end" style={{ height: KEEP_LABEL, paddingBottom: 10 }}>
            <h2 className="text-[34px] font-bold leading-none">{t("keepsakes.tickets")}</h2>
            <span className="ml-5 text-[24px] leading-none text-muted">{t(countKey(locale, page.total), { n: page.total })}</span>
          </div>
          <HRow
            focusKey="m-tickets"
            items={tickets}
            itemKey={(s) => `mt-${s.number}`}
            itemWidth={TICKET_W}
            itemHeight={TICKET_H}
            gap={36}
            viewport={viewport}
            initialIndex={initialIndex}
            onIndexChange={(i) => onIndexChange(i)}
            onSelect={(s) => onOpen(s.media)}
            renderItem={(s, focused) => (
              <div style={{ fontSize: TICKET_FONT }}>
                <TicketCard ticket={s} poster={imageUrl(cfg.data, s.media.poster_path, "w185")} cinema={page.cinema} focused={focused} />
              </div>
            )}
            tail={
              more > 0 ? (
                <div className="flex items-center text-[24px] text-muted" style={{ height: TICKET_H }}>
                  +{more}
                </div>
              ) : undefined
            }
          />
        </>
      )}
      {stickers.length > 0 && (
        <div style={{ height: KEEP_STICKERS, paddingTop: 14 }} data-testid="mine-stickers">
          <div className="flex items-baseline">
            <h2 className="text-[28px] font-bold leading-none">{t("keepsakes.stickers")}</h2>
            <span className="ml-5 text-[22px] text-muted">{secret ? t(secret, { n: achievements!.secret }) : t("keepsakes.all_found")}</span>
          </div>
          <div className="mt-3 whitespace-nowrap" style={{ fontSize: 21 }}>
            {stickers.map((a) => (
              <div key={a.id} className="inline-block align-top" style={{ marginRight: 28 }}>
                <StickerCard id={a.id} date={a.date} title={a.media_title} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

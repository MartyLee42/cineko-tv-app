// Home: «Продолжить смотреть ТВ: <канал>» — the profile's last live channel.
import { useEffect, useState } from "react";
import type { IptvChannel } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";
import { Brackets } from "../design/cards";
import { useDesign } from "../design/context";
import { epgProgress } from "./logic";
import { ChannelLogo, EpgBar } from "./ChannelLogo";
import { findChannel } from "./queries";

/** OK on the card: play it, switching through the full channel list. */
export function playLast(c: IptvChannel, onLive: (channel: IptvChannel, list: IptvChannel[]) => void) {
  void findChannel(c.id)
    .then((r) => onLive(r?.channel ?? c, r?.list ?? [c]))
    .catch(() => onLive(c, [c]));
}

export function LiveCard({ channel: c, focused, w, h, caption }: { channel: IptvChannel; focused: boolean; w: number; h: number; caption: boolean }) {
  const { t } = useI18n();
  const design = useDesign();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const frac = epgProgress(c.now, now);
  // The row is titled «Продолжить смотреть ТВ»: the card names the channel.
  const label = c.name;
  const terminal = design === "terminal";
  const projector = design === "projector";
  return (
    <div style={{ width: w }} data-live-card={c.id} aria-label={t("iptv.continue", { channel: c.name })}>
      <div className="relative" style={{ width: w, height: h }}>
        <div
          className={`tv-focus relative overflow-hidden ${terminal ? "border border-text/15" : "rounded-card"} ${focused ? "is-focused" : ""} ${projector ? "tv-panel" : "bg-surface-2"}`}
          style={{ width: w, height: h }}
        >
          <div className="absolute left-0 top-0 flex h-full w-full items-center justify-center" style={{ paddingBottom: projector ? 64 : 12 }}>
            <ChannelLogo channel={c} w={Math.round(w * 0.42)} h={Math.round(h * 0.5)} />
          </div>
          <span className={`absolute left-4 top-4 rounded-full bg-danger px-3 text-[17px] font-bold uppercase leading-[28px] text-bg ${terminal ? "t-label rounded-none" : ""}`}>
            ● {t("iptv.title")}
          </span>
          {projector && (
            <>
              <div className="p-card-shade absolute left-0 top-0 h-full w-full" />
              <p className="absolute bottom-8 left-6 right-6 truncate text-[24px] font-bold text-white">{label}</p>
            </>
          )}
          {frac !== null && <EpgBar fraction={frac} className="absolute bottom-3 left-4 right-4" />}
        </div>
        {terminal && focused && <Brackets small />}
      </div>
      {!projector &&
        (terminal ? (
          <p className={`t-label mt-3 truncate text-[17px] ${focused ? "text-text" : "text-muted"}`}>{label}</p>
        ) : (
          caption && (
            <>
              <p className={`mt-3 truncate text-[22px] leading-tight ${focused ? "font-bold text-text" : "text-text/85"}`}>{label}</p>
              <p className="mt-1 truncate text-[18px] text-muted">{c.now?.title ?? t("iptv.no_epg")}</p>
            </>
          )
        ))}
    </div>
  );
}

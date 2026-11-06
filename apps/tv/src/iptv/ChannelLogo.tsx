// Channel logo and programme bar: shared by Home's TV card, «ТВ», the day
// programme and the live player (kept apart so the player can load lazily).
import type { IptvChannel } from "@martytv/contracts";
import { Img } from "../components/Img";
import { channelInitials } from "./logic";

/** Channel logo in a fixed box, the number as a fallback. */
export function ChannelLogo({ channel, w, h, className = "" }: { channel: Pick<IptvChannel, "logo_url" | "number" | "name">; w: number; h: number; className?: string }) {
  return (
    <span className={`relative inline-block shrink-0 overflow-hidden ${className}`} style={{ width: w, height: h }}>
      <span className="absolute left-0 top-0 flex h-full w-full items-center justify-center font-bold text-muted" style={{ fontSize: Math.round(h * 0.36) }}>
        {channelInitials(channel.name)}
      </span>
      <Img src={channel.logo_url} className="absolute left-0 top-0 h-full w-full object-contain p-[6%]" />
    </span>
  );
}

/** A thin programme progress bar (transform only). */
export function EpgBar({ fraction, className = "" }: { fraction: number | null; className?: string }) {
  return (
    <span className={`relative block h-[6px] overflow-hidden rounded-full bg-text/20 ${className}`}>
      <span className="tv-progress-fill absolute left-0 top-0 h-full w-full" style={{ transform: `scaleX(${fraction ?? 0})` }} />
    </span>
  );
}

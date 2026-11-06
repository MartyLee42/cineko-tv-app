// Home card for live TV: phones reach «ТВ» from here (the bottom bar stays
// at 5 items). With a last channel it reads «Продолжить смотреть ТВ: …».
import { Link } from "react-router";
import { useI18n } from "@martytv/ui";
import { PlayIcon, TvIcon } from "../icons";
import { useIptvState } from "./queries";
import { ChannelLogo } from "./ui";

export function TvCard({ className = "" }: { className?: string }) {
  const { t } = useI18n();
  const q = useIptvState();
  const s = q.data;
  if (!s?.available) return null;
  const last = s.last?.channel ?? null;
  return (
    <div className={`flex flex-col gap-2 sm:flex-row ${className}`} data-testid="tv-card">
      {last && (
        <Link
          to={`/tv-channels?play=${last.id}`}
          data-testid="tv-continue"
          className="group flex min-w-0 flex-1 items-center gap-3 rounded-3xl border border-accent/30 bg-gradient-to-r from-accent/20 via-accent/5 to-surface p-3.5 transition hover:border-accent sm:p-4"
        >
          <ChannelLogo channel={last} size={52} />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold uppercase tracking-wide text-accent">{t("iptv.continue_short")}</span>
            <span className="block truncate text-lg font-bold">{last.name}</span>
            {last.now && <span className="block truncate text-sm text-muted">{last.now.title}</span>}
          </span>
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-xl text-on-accent group-hover:bg-accent-strong">
            <PlayIcon />
          </span>
        </Link>
      )}
      <Link
        to="/tv-channels"
        data-testid="tv-card-open"
        className={`group flex items-center gap-3 rounded-3xl border border-border bg-surface p-3.5 transition hover:border-muted sm:p-4 ${last ? "sm:w-72" : "flex-1"}`}
      >
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-surface-2 text-2xl text-accent">
          <TvIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-bold">
            {t("iptv.title")} · {t("iptv.web.card_title")}
          </span>
          <span className="block truncate text-sm text-muted">{t("iptv.web.card_text", { count: s.channel_count })}</span>
        </span>
      </Link>
    </div>
  );
}

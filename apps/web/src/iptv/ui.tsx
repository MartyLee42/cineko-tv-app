import { useEffect, useState } from "react";
import type { IptvChannel, IptvProgramme } from "@martytv/contracts";
import { useI18n, type MessageKey } from "@martytv/ui";
import { clock, initials, isKnownGroup, minutesLeft, programmeProgress } from "./logic";

/** Re-renders every `ms` so now/next progress moves. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function useGroupLabel() {
  const { t } = useI18n();
  return (id: string, name: string) => (isKnownGroup(id) || id === "all" || id === "favorites" ? t(`iptv.group.${id}` as MessageKey) : name);
}

export function ChannelLogo({ channel, size = 48, className = "" }: { channel: Pick<IptvChannel, "name" | "logo_url">; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white/90 text-sm font-bold text-black/70 ${className}`}
      style={style}
      aria-hidden
    >
      {channel.logo_url && !failed ? (
        <img src={channel.logo_url} alt="" loading="lazy" decoding="async" className="h-full w-full object-contain p-1" onError={() => setFailed(true)} />
      ) : (
        <span className="text-[0.8em]">{initials(channel.name)}</span>
      )}
    </span>
  );
}

export function StarButton({ on, onToggle, className = "" }: { on: boolean; onToggle: () => void; className?: string }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-pressed={on}
      aria-label={on ? t("iptv.unfavorite") : t("iptv.favorite")}
      data-testid="channel-favorite"
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xl transition hover:bg-surface-2 ${on ? "text-accent" : "text-muted"} ${className}`}
    >
      <Star filled={on} />
    </button>
  );
}

/** «Сейчас» line with a progress bar and «Далее» under it. */
export function NowNext({ now: p, next, at, compact = false }: { now: IptvProgramme | null; next: IptvProgramme | null; at: number; compact?: boolean }) {
  const { t, locale } = useI18n();
  if (!p && !next) return <p className="truncate text-sm text-muted">{t("iptv.no_epg")}</p>;
  const pct = Math.round(programmeProgress(p, at) * 100);
  return (
    <div className="min-w-0">
      {p && (
        <>
          <p className="flex min-w-0 items-baseline gap-2 text-sm">
            <span className="shrink-0 tabular-nums text-muted">{clock(p.start, locale)}</span>
            <span className="truncate font-medium" data-testid="channel-now">
              {p.title}
            </span>
            {!compact && <span className="ml-auto shrink-0 text-xs text-muted">{t("iptv.minutes_left", { minutes: minutesLeft(p, at) })}</span>}
          </p>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-text/15" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
        </>
      )}
      {next && (
        <p className="mt-1 flex min-w-0 items-baseline gap-2 text-xs text-muted">
          <span className="shrink-0 tabular-nums">{clock(next.start, locale)}</span>
          <span className="truncate" data-testid="channel-next">
            {next.title}
          </span>
        </p>
      )}
    </div>
  );
}

function Star({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" aria-hidden>
      <path d="m12 2.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3L2.9 9.5l6.3-.9z" />
    </svg>
  );
}

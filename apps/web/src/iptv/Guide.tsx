// Programme guide: a time × channels grid on desktop, a per-channel
// schedule sheet on phones.
import { Fragment, useEffect, useRef, useState } from "react";
import type { IptvChannel } from "@martytv/contracts";
import { Spinner, useI18n } from "@martytv/ui";
import { Button, ErrorText } from "../components";
import { Sheet } from "../remote/SendToTv";
import { blockSpan, clock, dayOffset, GUIDE_HOURS, guideWindow, programmeProgress, timeTicks } from "./logic";
import { useChannelEpg, useGuide } from "./queries";
import { ChannelLogo, useNow } from "./ui";

export function GuideGrid({ group, onOpen }: { group: string; onOpen: (c: IptvChannel) => void }) {
  const { t, locale } = useI18n();
  const now = useNow(30_000);
  const [shift, setShift] = useState(0);
  const { from, to } = guideWindow(now, GUIDE_HOURS, shift);
  const q = useGuide(from, to, group);
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const ticks = timeTicks(from, to, 30);
  const nowPct = now >= from && now < to ? ((now - from) / (to - from)) * 100 : null;

  return (
    <div className="space-y-3" data-testid="iptv-guide">
      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={() => setShift((s) => s - 1)} data-testid="guide-earlier">
          ← {t("iptv.web.earlier")}
        </Button>
        <Button variant={shift === 0 ? "primary" : "secondary"} onClick={() => setShift(0)}>
          {t("iptv.web.to_now")}
        </Button>
        <Button variant="secondary" onClick={() => setShift((s) => s + 1)} data-testid="guide-later">
          {t("iptv.web.later")} →
        </Button>
        {q.isFetching && <Spinner size={20} />}
      </div>
      <ErrorText error={q.error} />
      <div className="overflow-hidden rounded-2xl border border-border bg-surface">
        <div className="grid grid-cols-[220px_1fr] border-b border-border text-xs text-muted">
          <div className="px-3 py-2" />
          <div className="relative h-8">
            {ticks.map((tk) => (
              <span key={tk} className="absolute top-2 -translate-x-1/2 tabular-nums first:translate-x-0" style={{ left: `${((tk - from) / (to - from)) * 100}%` }}>
                {clock(new Date(tk).toISOString(), locale)}
              </span>
            ))}
          </div>
        </div>
        {q.isPending ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : (
          rows.map(({ channel, programmes }) => (
            <div key={channel.id} className={`grid grid-cols-[220px_1fr] border-b border-border/60 last:border-0 ${channel.offline ? "opacity-50" : ""}`} data-testid="guide-row">
              <button type="button" onClick={() => onOpen(channel)} className="flex min-w-0 items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-2">
                <span className="w-7 shrink-0 text-right text-xs tabular-nums text-muted">{channel.number}</span>
                <ChannelLogo channel={channel} size={32} />
                <span className="truncate text-sm font-medium">{channel.name}</span>
              </button>
              <div className="relative h-14 border-l border-border/60">
                {programmes.map((p) => {
                  const span = blockSpan(p, from, to);
                  if (!span) return null;
                  const live = Date.parse(p.start) <= now && now < Date.parse(p.stop);
                  return (
                    <button
                      key={p.start}
                      type="button"
                      onClick={() => onOpen(channel)}
                      title={`${clock(p.start, locale)}–${clock(p.stop, locale)} ${p.title}`}
                      data-testid="guide-programme"
                      data-live={live}
                      className={`absolute inset-y-1 overflow-hidden rounded-lg border px-2 py-1 text-left text-xs transition hover:border-accent ${
                        live ? "border-accent/50 bg-accent/15" : "border-border bg-bg/40"
                      }`}
                      style={{ left: `calc(${span.left}% + 2px)`, width: `calc(${span.width}% - 4px)` }}
                    >
                      <span className="block truncate font-medium">{p.title}</span>
                      <span className="block truncate tabular-nums text-muted">{clock(p.start, locale)}</span>
                    </button>
                  );
                })}
                {!programmes.length && <span className="absolute inset-0 flex items-center px-3 text-xs text-muted">{t("iptv.no_epg")}</span>}
                {nowPct != null && <span className="pointer-events-none absolute inset-y-0 w-0.5 bg-red-500" style={{ left: `${nowPct}%` }} aria-hidden />}
              </div>
            </div>
          ))
        )}
      </div>
      {q.hasNextPage && (
        <Button variant="secondary" onClick={() => void q.fetchNextPage()} busy={q.isFetchingNextPage} className="w-full" data-testid="guide-more">
          {t("iptv.web.more_channels")}
        </Button>
      )}
    </div>
  );
}

/** One channel's schedule (phones, and «Программа» from the channel sheet). */
export function ScheduleSheet({ channel, onClose, onWatch }: { channel: IptvChannel; onClose: () => void; onWatch: () => void }) {
  const { t, locale } = useI18n();
  const now = useNow(30_000);
  const q = useChannelEpg(channel.id);
  const current = useRef<HTMLLIElement>(null);
  useEffect(() => {
    current.current?.scrollIntoView?.({ block: "center" });
  }, [q.data]);
  const dayLabel = (iso: string) => {
    const d = dayOffset(iso, now);
    if (d === 0) return t("iptv.web.today");
    if (d === 1) return t("iptv.web.tomorrow");
    if (d === -1) return t("iptv.web.yesterday");
    return new Date(iso).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });
  };
  const items = (q.data ?? []).map((p, i, all) => ({ p, day: dayLabel(p.start), first: i === 0 || dayLabel(all[i - 1]!.start) !== dayLabel(p.start) }));
  return (
    <Sheet title={channel.name} subtitle={t("iptv.schedule")} onClose={onClose} testId="iptv-schedule">
      <Button className="mb-3 w-full" onClick={onWatch}>
        {t("iptv.web.watch_here")}
      </Button>
      <ErrorText error={q.error} />
      {q.isPending ? (
        <div className="flex justify-center p-6">
          <Spinner />
        </div>
      ) : !q.data?.length ? (
        <p className="py-6 text-center text-muted">{t("iptv.web.schedule_empty")}</p>
      ) : (
        <ul className="space-y-1">
          {items.map(({ p, day, first: header }) => {
            const live = Date.parse(p.start) <= now && now < Date.parse(p.stop);
            const past = Date.parse(p.stop) <= now;
            return (
              <Fragment key={p.start}>
                {header && <li className="px-1 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted first:pt-0">{day}</li>}
                <li ref={live ? current : undefined} data-testid="schedule-item" data-live={live} className={`rounded-xl px-3 py-2 ${live ? "bg-accent/15" : ""} ${past ? "opacity-55" : ""}`}>
                  <div className="flex items-baseline gap-3">
                    <span className="w-12 shrink-0 tabular-nums text-sm text-muted">{clock(p.start, locale)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{p.title}</span>
                      {p.description && live && <span className="mt-0.5 line-clamp-3 block text-xs text-muted">{p.description}</span>}
                    </span>
                  </div>
                  {live && (
                    <div className="ml-[3.75rem] mt-1.5 h-1 overflow-hidden rounded-full bg-text/15">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(programmeProgress(p, now) * 100)}%` }} />
                    </div>
                  )}
                </li>
              </Fragment>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}

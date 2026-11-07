// «Программа на сегодня»: one channel's programmes for the local day (00:00–24:00).
// Aired shows are dimmed, the current one is highlighted with its progress and
// focused first; the focused show's details are on the right. OK on any show
// starts the channel live (the playlists have no archive / catch-up).
import { useEffect, useMemo, useState } from "react";
import type { IptvChannel } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";
import { useInitialFocus } from "../../focus";
import { cardKey } from "../../catalog/focusKeys";
import type { RouteMemory } from "../../catalog/nav";
import { VGrid } from "../../components/VGrid";
import { ErrorState, GridSkeleton } from "../../components/States";
import { useDesign, useFrame } from "../../design/context";
import { ScreenTitle } from "../../design/grid";
import { useReportDeep, useToTop } from "../../design/topJump";
import { dayStatuses, dayWindow, epgProgress, hhmm, minutesLeft } from "../../iptv/logic";
import { ChannelLogo, EpgBar } from "../../iptv/ChannelLogo";
import { useChannelDay } from "../../iptv/queries";

const EDGE = 40;
const LIST_TOP = 230;
const ROW_H = 92;
const LIST_W = 1000;

export function TvDayScreen({ channel, mem, onPlay }: { channel: IptvChannel; mem: RouteMemory; onPlay: (c: IptvChannel) => void }) {
  const { t, locale } = useI18n();
  const design = useDesign();
  const frame = useFrame();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  // The day is fixed when the screen opens (not shifted at midnight while it's up).
  const [day] = useState(() => dayWindow(Date.now()));
  const q = useChannelDay(channel.id, day.from, day.to);
  const items = useMemo(() => q.data ?? [], [q.data]);
  const { status, focus } = dayStatuses(items, now);
  const [idx, setIdx] = useState(() => mem.get<number>("idx") ?? -1);
  const shown = idx >= 0 && idx < items.length ? idx : focus;
  const sel = items[shown];
  const [ty, setTy] = useState(() => mem.get<number>("ty") ?? 0);
  const scrollTo = (i: number) => {
    const v = Math.max(0, i * ROW_H - 3 * ROW_H);
    setTy(v);
    mem.set("ty", v);
  };
  useInitialFocus(!q.isPending, mem, () => (items[focus] ? cardKey("day", `${focus}`) : q.isError ? "day-retry" : undefined));
  // First show: scroll the current programme into view.
  const [scrolled, setScrolled] = useState(mem.get<number>("ty") !== undefined);
  if (!scrolled && items.length > 0) {
    setScrolled(true);
    scrollTo(focus);
  }
  useToTop(() => {
    setTy(0);
    mem.set("ty", 0);
    return false;
  });
  useReportDeep(ty > 0);
  const dateLabel = day.from.toLocaleDateString(locale === "en" ? "en-GB" : locale === "kk" ? "kk-KZ" : "ru-RU", { weekday: "long", day: "numeric", month: "long" });

  let body: React.ReactNode;
  if (q.isPending) body = <GridSkeleton cols={1} width={LIST_W} height={ROW_H - 12} pitchX={LIST_W} pitchY={ROW_H} />;
  else if (q.isError) body = <ErrorState focusKey="day-retry" error={q.error} onRetry={() => void q.refetch()} />;
  else if (!items.length) body = <p className="text-[30px] text-muted">{t("iptv.day.empty")}</p>;
  else
    body = (
      <VGrid
        focusKey="day-list"
        items={items.map((p, i) => ({ p, i }))}
        itemKey={(x) => cardKey("day", `${x.i}`)}
        cols={1}
        itemWidth={LIST_W}
        pitchX={LIST_W}
        pitchY={ROW_H}
        rowsBefore={4}
        rowsAfter={8}
        initialIndex={shown}
        onIndexChange={(i) => {
          setIdx(i);
          mem.set("idx", i);
          scrollTo(i);
        }}
        onSelect={() => onPlay(channel)}
        renderItem={({ p, i }, focused) => {
          const st = status[i];
          return (
            <div
              data-day-row={i}
              data-status={st}
              className={`tv-focus flex items-center rounded-control px-6 ${focused ? "is-focused" : ""} ${st === "now" ? "bg-accent/15" : ""} ${st === "past" && !focused ? "opacity-45" : ""}`}
              style={{ width: LIST_W, height: ROW_H - 12 }}
            >
              <span className={`w-[110px] shrink-0 font-mono text-[28px] tabular-nums ${st === "now" ? "font-bold text-accent" : "text-muted"}`}>{hhmm(p.start)}</span>
              <span className={`min-w-0 flex-1 truncate text-[30px] ${st === "now" || focused ? "font-semibold" : ""}`}>{p.title}</span>
              {st === "now" && <span className="ml-4 shrink-0 rounded-full bg-accent px-3 py-0.5 text-[20px] font-bold text-on-accent">{t("iptv.day.now")}</span>}
            </div>
          );
        }}
      />
    );

  const selStatus = sel ? status[shown] : undefined;
  const frac = sel && selStatus === "now" ? epgProgress(sel, now) : null;
  const left = sel && selStatus === "now" ? minutesLeft(sel, now) : null;
  return (
    <div data-testid="tv-day" data-channel-id={channel.id} className="absolute overflow-hidden" style={{ left: frame.x - EDGE, right: 0, top: frame.top, bottom: 1080 - frame.bottom }}>
      <div className="absolute flex items-end" style={{ left: EDGE, top: 0, height: 180 }}>
        <ChannelLogo channel={channel} w={120} h={90} className="mr-6 rounded-[12px] bg-white/10" />
        <div className="pb-2">
          <ScreenTitle design={design}>{channel.name}</ScreenTitle>
          <p className="mt-2 text-[26px] text-muted">
            {t("iptv.day.title")} · {dateLabel}
          </p>
        </div>
      </div>
      {/* Padded so the focus frame isn't clipped. */}
      <div className="absolute overflow-hidden" style={{ left: EDGE - 16, top: LIST_TOP - 16, width: LIST_W + 40, bottom: 70 }}>
        <div className="tv-track absolute right-0 top-0" style={{ left: 16, top: 16, transform: `translate3d(0,${-ty}px,0)` }}>
          {body}
        </div>
      </div>
      {sel && (
        <aside data-testid="tv-day-detail" className="absolute" style={{ left: EDGE + LIST_W + 70, right: 100, top: LIST_TOP }}>
          <p className="font-mono text-[26px] text-muted">
            {hhmm(sel.start)} – {hhmm(sel.stop)}
            {selStatus === "past" ? ` · ${t("iptv.day.ended")}` : ""}
          </p>
          <h2 className="mt-3 line-clamp-3 text-[44px] font-bold leading-tight">{sel.title}</h2>
          {sel.category && <p className="mt-3 text-[24px] text-accent">{sel.category}</p>}
          {frac !== null && (
            <div className="mt-6 flex items-center">
              <EpgBar fraction={frac} className="w-[360px]" />
              {left !== null && <span className="ml-5 text-[24px] text-muted">{t("iptv.day.left", { n: left })}</span>}
            </div>
          )}
          {sel.description && <p className="mt-6 line-clamp-[9] text-[25px] leading-snug text-text/80">{sel.description}</p>}
        </aside>
      )}
      <p className="absolute bottom-6 text-[22px] text-muted" style={{ left: EDGE }}>
        {t("iptv.day.hint")}
      </p>
    </div>
  );
}

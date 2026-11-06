// The live channel's programme for today, over the picture (→ / INFO / GUIDE
// while watching): aired shows dimmed, the current one highlighted with its
// progress; ▲▼ scroll, ← / Back close. No archive in the playlists, so it's
// for reading — the channel keeps playing.
import { useEffect, useMemo, useState } from "react";
import type { IptvChannel } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";
import { dayStatuses, dayWindow, epgProgress, hhmm, PROGRAM_ROWS, programWindow } from "./logic";
import { EpgBar } from "./ChannelLogo";
import { useChannelDay } from "./queries";

const ROW_H = 78;

export function useChannelProgram(channel: IptvChannel, enabled: boolean) {
  const [day] = useState(() => dayWindow(Date.now()));
  const q = useChannelDay(channel.id, day.from, day.to, enabled);
  return { items: useMemo(() => q.data ?? [], [q.data]), pending: q.isPending, error: q.isError };
}

export function ProgramPanel({ channel, sel, items, pending, error }: { channel: IptvChannel; sel: number | null; items: ReturnType<typeof useChannelProgram>["items"]; pending: boolean; error: boolean }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const { status, focus } = dayStatuses(items, now);
  const at = sel ?? focus;
  const top = programWindow(at, items.length);
  const shown = items.slice(top, top + PROGRAM_ROWS);
  const cur = items[at];
  return (
    <div data-testid="live-program" className="absolute right-0 top-0 z-20 flex h-full w-[820px] flex-col bg-black/85 px-12 py-14">
      <p className="text-[24px] text-white/60">{t("iptv.day.title")}</p>
      <h2 className="mt-1 truncate text-[40px] font-bold text-white">{channel.name}</h2>
      <div className="mt-8 flex-1">
        {pending ? (
          <p className="text-[26px] text-white/60">…</p>
        ) : error || items.length === 0 ? (
          <p className="text-[26px] text-white/60">{t("iptv.day.empty")}</p>
        ) : (
          shown.map((p, j) => {
            const i = top + j;
            const st = status[i];
            const on = i === at;
            return (
              <div
                key={i}
                data-program-row={i}
                data-status={st}
                className={`flex items-center rounded-xl px-5 ${on ? "bg-white text-black" : st === "now" ? "bg-white/15 text-white" : "text-white"} ${st === "past" && !on ? "opacity-45" : ""}`}
                style={{ height: ROW_H - 10, marginBottom: 10 }}
              >
                <span className="w-[100px] shrink-0 font-mono text-[26px] tabular-nums">{hhmm(p.start)}</span>
                <span className={`min-w-0 flex-1 truncate text-[28px] ${st === "now" ? "font-semibold" : ""}`}>{p.title}</span>
                {st === "now" && <span className={`ml-3 shrink-0 rounded-full px-3 py-0.5 text-[18px] font-bold ${on ? "bg-black text-white" : "bg-accent text-on-accent"}`}>{t("iptv.day.now")}</span>}
              </div>
            );
          })
        )}
      </div>
      {cur && (
        <div className="border-t border-white/15 pt-5">
          <p className="font-mono text-[22px] text-white/60">
            {hhmm(cur.start)} – {hhmm(cur.stop)}
          </p>
          {status[at] === "now" && <EpgBar fraction={epgProgress(cur, now)} className="mt-3 w-[360px]" />}
          {cur.description && <p className="mt-3 line-clamp-3 text-[22px] leading-snug text-white/80">{cur.description}</p>}
        </div>
      )}
      <p className="mt-4 text-[20px] text-white/50">▲▼ · ← {t("common.back")}</p>
    </div>
  );
}

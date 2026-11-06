// «Награды» on the TV details: a focusable one-line summary in the header
// («🏆 Оскар ×3 · Канны: Золотая пальмовая ветвь · Награды ▸») and the
// full-screen panel it opens (wins per award and year, nominations muted).
// The panel listens on window like ActionMenu: ▲▼ scroll, OK/Back close;
// spatial focus stays on the line, so closing returns to it.
import { useEffect, useRef } from "react";
import type { MediaDetail } from "@martytv/contracts";
import { awardLineText, awardNominationCount, awardsByYear, awardsSummaryLine, nominationsLabel, useI18n } from "@martytv/ui";
import { FocusButton } from "../focus";
import { playerKey } from "../player/keys";
import { claimKeys } from "../remote/keyOwner";

type Awards = MediaDetail["awards"];

/** Scroll step of the panel per ▲/▼ (px). */
const STEP = 160;

/** The header line; renders nothing without awards. */
export function AwardsLine({ awards, onOpen, className = "" }: { awards: Awards | undefined; onOpen: (() => void) | null; className?: string }) {
  const { t, locale } = useI18n();
  if (!awards?.length || !onOpen) return null;
  const summary = awardsSummaryLine(awards);
  const noms = awardNominationCount(awards);
  return (
    <div className={`flex ${className}`}>
      <FocusButton focusKey="d-awards" onPress={onOpen} className="flex h-[52px] min-w-0 max-w-[1060px] items-center rounded-control px-4 text-[23px]" focusedClassName="!bg-text !text-bg">
        <span data-testid="tv-awards-line" className="truncate">
          {summary || `🏆 ${t("awards.title")}`}
          {noms > 0 && <span className="opacity-70">{`  ·  ${nominationsLabel(noms, locale, t)}`}</span>}
        </span>
        <span data-testid="tv-awards-open" className="ml-4 shrink-0 font-bold opacity-80">
          {t("awards.open")} ▸
        </span>
      </FocusButton>
    </div>
  );
}

export function AwardsPanel({ title, awards, onClose }: { title: string; awards: Awards; onClose: () => void }) {
  const { t, locale } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const c = claimKeys();
    const onKey = (e: KeyboardEvent) => {
      if (!c.top) return;
      const k = playerKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const el = box.current;
      if (k === "up" && el) el.scrollTop = Math.max(0, el.scrollTop - STEP);
      else if (k === "down" && el) el.scrollTop = el.scrollTop + STEP;
      else if (k === "back" || k === "stop" || ((k === "ok" || k === "play" || k === "playpause") && !e.repeat)) close.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      c.release();
    };
  }, []);
  const wins = awards.filter((g) => g.wins.length > 0);
  const noms = awards.filter((g) => g.nominations.length > 0);
  const nomCount = awardNominationCount(awards);
  return (
    // Fixed over the whole 1920×1080 canvas, like ActionMenu.
    <div data-testid="tv-awards-panel" className="fixed left-0 top-0 z-30 flex h-[1080px] w-[1920px] items-center justify-center bg-black/70">
      <div className="flex h-[900px] w-[1300px] flex-col rounded-card bg-surface px-16 py-12 shadow-2xl">
        <h2 className="truncate text-5xl font-bold leading-tight">
          🏆 {t("awards.title")} · {title}
        </h2>
        <div ref={box} className="mt-8 min-h-0 flex-1 overflow-hidden">
          {wins.length > 0 && <p className="text-[24px] font-bold uppercase tracking-[.12em] text-accent">{t("awards.wins")}</p>}
          {wins.map((g) =>
            awardsByYear(g.wins).map((line, i) => (
              <p key={`${g.group}-w-${i}`} data-award-win className="mt-4 text-[30px] leading-snug">
                <span className="mr-3">🏆</span>
                {awardLineText(g.group_label, line)}
              </p>
            )),
          )}
          {noms.length > 0 && (
            <p className={`${wins.length > 0 ? "mt-10" : ""} text-[24px] font-bold uppercase tracking-[.12em] text-muted`}>
              {t("awards.nominations")} · {nominationsLabel(nomCount, locale, t)}
            </p>
          )}
          {noms.map((g) =>
            awardsByYear(g.nominations).map((line, i) => (
              <p key={`${g.group}-n-${i}`} data-award-nomination className="mt-3 text-[26px] leading-snug text-muted">
                {awardLineText(g.group_label, line)}
              </p>
            )),
          )}
          <div className="h-[200px]" />
        </div>
        <p className="mt-6 text-[20px] text-muted">
          {t("awards.source")} · ▲▼ · {t("common.close")}: OK / ←
        </p>
      </div>
    </div>
  );
}

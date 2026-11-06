// «Конструктивизм» on TV, the extras: the «очередь за дефицитом» over
// Details, Home's red news strip, the five-year-plan plaque (with the week's
// «стахановец») and the «план перевыполнен» toast. Never focusable.
import { useEffect, useState } from "react";
import { filmsRu, isDeficit, NewsTicker, QUEUE_MS, queuePlace, queueText, takeQueueTurn, useDocumentHidden, type Plan } from "@martytv/ui";

const grot = "var(--mt-font-display)";

/** Decided once per Details entry (StrictMode-safe: the session record is taken once). */
const queueDecided = new Map<string, boolean>();
function queueDecision(entryKey: string, media: { id: string; vote_count?: number | null; rating?: number | null }): boolean {
  let v = queueDecided.get(entryKey);
  if (v === undefined) {
    v = isDeficit(media) && takeQueueTurn(media.id);
    queueDecided.set(entryKey, v);
  }
  return v;
}

/**
 * «Вы 3-й в очереди за дефицитом…» over Details for ~1.2 s when a popular
 * title is opened from the catalog (never from a phone's media.open — those
 * carry no preview); once per title per session; any key skips it (OK is
 * swallowed, other keys act as usual).
 */
export function CvQueue({ entryKey, media }: { entryKey: string; media: { id: string; vote_count?: number | null; rating?: number | null } }) {
  const [show] = useState(() => queueDecision(entryKey, media));
  const [place] = useState(() => queuePlace());
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!show || done) return;
    const id = setTimeout(() => setDone(true), QUEUE_MS);
    // Any key skips it; OK is used up (it must not press «Смотреть» underneath), Back / arrows go on as usual.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.keyCode === 13) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      setDone(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(id);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [show, done]);
  if (!show || done) return null;
  return (
    <div data-testid="cv-queue" className="cv-queue absolute left-0 top-0 z-40 flex h-full w-full items-center justify-center">
      <div className="cv-toast px-16 py-10 text-[64px] font-bold uppercase leading-tight" style={{ fontFamily: grot }}>
        {queueText(place)}
      </div>
    </div>
  );
}

/** The red news strip under the menu (paused while the app is hidden; Home is gone during playback). */
export function CvNewsStrip({ top }: { top: number }) {
  const hidden = useDocumentHidden();
  return <NewsTicker paused={hidden} seconds={110} className="absolute left-0 right-0 h-[40px] text-[22px] leading-[40px]" style={{ top }} />;
}

/** «Пятилетка»: titles finished this year against the plan, and the week's «стахановец». */
export function CvPlanPlaque({ plan, hero, left, top }: { plan: Plan; hero: { name: string; count: number } | null; left: number; top: number }) {
  return (
    <div data-testid="cv-plan" className="cv-plan pointer-events-none absolute w-[400px] px-6 py-4" style={{ left, top }}>
      <p className="text-[19px] font-bold uppercase tracking-[.16em] text-[#d7261e]" style={{ fontFamily: grot }}>
        Пятилетка {plan.year}
      </p>
      <p className="mt-1 text-[30px] font-bold uppercase leading-tight" style={{ fontFamily: grot }}>
        {plan.done} из {plan.target} · {plan.pct}%
      </p>
      <div className="relative mt-2 h-[10px] bg-[#1a1512]/20">
        <div className="absolute left-0 top-0 h-full w-full origin-left bg-[#d7261e]" style={{ transform: `scaleX(${Math.min(1, plan.done / plan.target)})` }} />
      </div>
      {hero && (
        <p data-testid="cv-stakhanov" className="mt-2 truncate text-[19px] font-bold uppercase" style={{ fontFamily: grot }}>
          Стахановец недели: {hero.name} — {hero.count} {filmsRu(hero.count)}
        </p>
      )}
    </div>
  );
}

/** «ПЛАН ПЕРЕВЫПОЛНЕН!» for ~5 s when a title was finished since the last look. */
export function CvPlanToast({ titles }: { titles: { id: string; title: string }[] }) {
  const [gone, setGone] = useState<typeof titles | null>(null);
  useEffect(() => {
    if (!titles.length) return;
    const id = setTimeout(() => setGone(titles), 5000);
    return () => clearTimeout(id);
  }, [titles]);
  if (!titles.length || gone === titles) return null;
  return (
    <div data-testid="cv-plan-toast" className="cv-toast pointer-events-none absolute right-[120px] top-[200px] z-30 max-w-[760px] px-10 py-6">
      <p className="text-[56px] font-bold uppercase leading-none" style={{ fontFamily: grot }}>
        План перевыполнен!
      </p>
      <p className="mt-3 truncate text-[26px]">«{titles[0]!.title}» — досмотрено</p>
    </div>
  );
}

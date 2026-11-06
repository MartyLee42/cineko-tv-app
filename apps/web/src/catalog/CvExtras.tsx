// «Конструктивизм» on the web, the extras: Home's red news strip, the
// five-year plan (with the week's «стахановец»), the «план перевыполнен»
// toast, the «Рекомендовано Госкино» shelf, and the «очередь за дефицитом»
// over a popular title opened inside the app.
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { filmsRu, isDeficit, NewsTicker, QUEUE_MS, queuePlace, queueText, takeQueueTurn, useConstructivism, useDocumentHidden } from "@martytv/ui";
import { PosterRow } from "./components";
import { useMedia } from "./queries";
import { useCvStats, useGoskino } from "./cvData";

/** The red news strip (slow marquee; paused while the tab is hidden — the player is another page). */
export function CvNews() {
  const cv = useConstructivism();
  const hidden = useDocumentHidden();
  if (!cv) return null;
  return <NewsTicker paused={hidden} seconds={80} className="-mx-4 h-9 text-sm leading-9 sm:mx-0 sm:h-10 sm:text-base sm:leading-10" />;
}

/** «Пятилетка»: titles finished this year against the plan; the week's «стахановец»; the toast on a fresh finish. */
export function CvPlan() {
  const cv = useConstructivism();
  const stats = useCvStats(cv);
  const d = stats.data;
  if (!cv || !d) return null;
  const { plan, hero } = d;
  return (
    <section data-testid="cv-plan" aria-label={`Пятилетка ${plan.year}`} className="cv-plan-web relative overflow-hidden px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-1">
        <p className="font-display text-sm font-bold uppercase tracking-[0.2em] text-[#d7261e]">Пятилетка {plan.year} · план по просмотру</p>
        <p className="font-display text-2xl font-bold uppercase leading-none sm:text-4xl">
          Просмотрено {plan.done} из {plan.target} <span className="text-[#d7261e]">({plan.pct}%)</span>
        </p>
      </div>
      <div className="mt-3 h-3 bg-[#1a1512]/15">
        <div className="h-full bg-[#d7261e]" style={{ width: `${Math.min(100, (plan.done / plan.target) * 100)}%` }} />
      </div>
      {hero && (
        <p data-testid="cv-stakhanov" className="mt-3 font-display text-base font-bold uppercase tracking-wide sm:text-lg">
          ★ Стахановец недели: {hero.name} — {hero.count} {filmsRu(hero.count)}
        </p>
      )}
      <CvPlanToast titles={d.fresh} />
    </section>
  );
}

function CvPlanToast({ titles }: { titles: { id: string; title: string }[] }) {
  const [gone, setGone] = useState<typeof titles | null>(null);
  useEffect(() => {
    if (!titles.length) return;
    const id = setTimeout(() => setGone(titles), 5000);
    return () => clearTimeout(id);
  }, [titles]);
  if (!titles.length || gone === titles) return null;
  return (
    <div role="status" data-testid="cv-plan-toast" className="cv-toast-web fixed inset-x-4 bottom-24 z-30 mx-auto max-w-md px-5 py-4 md:bottom-8">
      <p className="font-display text-3xl font-bold uppercase leading-none">План перевыполнен!</p>
      <p className="mt-1 truncate text-sm">«{titles[0]!.title}» — досмотрено</p>
    </div>
  );
}

/** «Рекомендовано Госкино»: the curated Soviet classics list (cached). */
export function CvGoskino() {
  const cv = useConstructivism();
  const q = useGoskino(cv);
  if (!cv || !q.data?.length) return null;
  return <PosterRow testId="row-cv-goskino" title="Рекомендовано Госкино" items={q.data} />;
}

/** Decided once per history entry (render may run twice). */
const decided = new Map<string, boolean>();

/**
 * «Вы 3-й в очереди за дефицитом…» for ~1.2 s over a popular title opened
 * inside the app (never on a deep link / first page load); once per title per
 * session; a tap or any key skips it.
 */
export function CvQueue({ id }: { id: string }) {
  const cv = useConstructivism();
  const location = useLocation();
  const media = useMedia(id);
  const [place] = useState(() => queuePlace());
  const [done, setDone] = useState(false);
  const k = `${location.key}:${id}`;
  let show = false;
  if (cv && location.key !== "default" && media.data) {
    let v = decided.get(k);
    if (v === undefined) {
      v = isDeficit(media.data) && takeQueueTurn(id);
      decided.set(k, v);
    }
    show = v;
  }
  const on = show && !done;
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => setDone(true), QUEUE_MS);
    const skip = () => setDone(true);
    window.addEventListener("keydown", skip, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", skip, true);
    };
  }, [on]);
  if (!on) return null;
  return (
    <div data-testid="cv-queue" onClick={() => setDone(true)} className="cv-queue-web fixed inset-0 z-50 flex items-center justify-center p-6">
      <p className="cv-toast-web max-w-xl px-6 py-5 text-center font-display text-3xl font-bold uppercase leading-tight sm:text-5xl">{queueText(place)}</p>
    </div>
  );
}

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@martytv/contracts";
import { Spinner, useI18n } from "@martytv/ui";
import { useRegenerate, useRegenStatus } from "./queries";
import { regenState, regenTime } from "./taste";

/**
 * «Обновить подборки ИИ» (once a day per profile; «Для вас» header and the
 * Explore «Подборки дня» header). While running it shows a spinner; rows and
 * collections refresh on `foryou.updated` (and once more when it ends).
 */
export function RegenButton({ className = "" }: { className?: string }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const q = useRegenStatus();
  const regen = useRegenerate();
  const state = regenState(q.data);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (state === "running") wasRunning.current = true;
    else if (wasRunning.current) {
      wasRunning.current = false;
      for (const k of ["rows", "collections", "explore"]) void qc.invalidateQueries({ queryKey: ["foryou", k] });
    }
  }, [state, qc]);
  if (state === "hidden") return null;

  const err = regen.error;
  const errText =
    err instanceof ApiError && err.code === "ai_budget" ? t("taste.regen.budget") : err && !(err instanceof ApiError && err.code === "regen_limit") ? t("taste.regen.failed") : null;
  const hint =
    state === "used"
      ? t("taste.regen.used", { time: regenTime(q.data!.next_available_at, locale) })
      : q.data!.unlimited
        ? t("taste.regen.hint_unlimited")
        : t("taste.regen.hint");
  return (
    <div className={`flex flex-col items-start gap-0.5 ${className}`} data-testid="regen" data-state={state}>
      <button
        type="button"
        data-testid="regen-button"
        disabled={state !== "available" || regen.isPending}
        onClick={() => regen.mutate()}
        className="flex min-h-[40px] items-center gap-2 rounded-full bg-surface-2 px-3.5 text-sm font-semibold hover:bg-border disabled:cursor-not-allowed disabled:opacity-60"
      >
        {state === "running" || regen.isPending ? <Spinner size={16} /> : <span aria-hidden>↻</span>}
        {state === "running" ? t("taste.regen.running") : t("taste.regen")}
      </button>
      <span data-testid="regen-hint" className="px-1 text-xs text-muted">
        {errText ?? hint}
      </span>
    </div>
  );
}

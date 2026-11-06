import { fitChipText, type Fit, type FitTone } from "@martytv/media-types";
import { useI18n, type MessageKey } from "@martytv/ui";

const TONE: Record<FitTone, string> = {
  ok: "border-ok/40 bg-ok/10 text-ok",
  convert: "border-sky-500/40 bg-sky-500/10 text-sky-500",
  warn: "border-warn/40 bg-warn/10 text-warn",
  bad: "border-danger/40 bg-danger/10 text-danger",
  info: "border-border bg-surface-2 text-text/80",
};

/** «✓ Пойдёт на Living Room» · «Звук DTS → сервер переведёт в AAC» · «4K: экран 1080p». */
export function FitChips({ fit }: { fit: Fit }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="fit-chips" data-verdict={fit.verdict}>
      {fit.chips.map((c) => (
        <span
          key={c.code}
          data-fit={c.code}
          data-tone={c.tone}
          className={`inline-flex min-h-6 items-center rounded-md border px-1.5 py-0.5 text-[11px] leading-tight font-bold tracking-wide ${TONE[c.tone]}`}
        >
          {fitChipText(c, (k, v) => t(k as MessageKey, v))}
        </span>
      ))}
    </div>
  );
}

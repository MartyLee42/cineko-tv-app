import { fitChipShort, fitChipText, fitHeadline, type Fit, type FitChip, type FitTone } from "@martytv/media-types";
import { useI18n, type MessageKey } from "@martytv/ui";

const TONE: Record<FitTone, string> = {
  ok: "bg-ok/15 text-ok",
  convert: "bg-sky-500/15 text-sky-500",
  warn: "bg-warn/15 text-warn",
  bad: "bg-danger/20 text-danger",
  info: "bg-text/10 text-text/80",
};

/**
 * This release on this TV, as colored chips: «✓ Пойдёт» · «Звук DTS → сервер
 * переведёт в AAC» · «✗ Видео HEVC не поддерживается» · «4K: экран 1080p».
 * `compact`: one short chip («✓», «DTS→AAC», «✗ HEVC») for tight rows (the
 * Details sources table).
 */
export function FitLine({ fit, compact = false }: { fit: Fit; compact?: boolean }) {
  const { t } = useI18n();
  const head = compact ? fitHeadline(fit) : null;
  const chips: FitChip[] = compact ? (head ? [head] : []) : fit.chips;
  if (chips.length === 0) return null;
  return (
    <span data-fit-verdict={fit.verdict}>
      {chips.map((c) => (
        <span key={c.code} data-fit={c.code} className={`mr-3 rounded-lg ${compact ? "px-2 py-0.5 text-[17px]" : "px-3 py-0.5"} ${TONE[c.tone]}`}>
          {compact ? fitChipShort(c) : fitChipText(c, (k, v) => t(k as MessageKey, v))}
        </span>
      ))}
    </span>
  );
}

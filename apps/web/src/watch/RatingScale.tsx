import { useI18n } from "@martytv/ui";

/** The 1–10 picker (title page, the rating popover, card quick actions). */
export function RatingScale({ value, onPick, size = "md" }: { value: number | null; onPick: (n: number) => void; size?: "sm" | "md" }) {
  const { t } = useI18n();
  return (
    <div role="radiogroup" aria-label={t("lists.rate")} className="flex flex-wrap gap-1.5" data-testid="rating-scale">
      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
        const on = value === n;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onPick(n)}
            className={`${size === "sm" ? "h-9 w-9 text-sm" : "h-10 w-10"} rounded-full border font-bold transition ${
              on
                ? "border-accent bg-accent text-on-accent"
                : value != null && n < value
                  ? "border-accent/50 bg-accent/15 text-accent-strong"
                  : "border-border bg-surface text-text hover:border-accent"
            }`}
          >
            {n}
          </button>
        );
      })}
    </div>
  );
}

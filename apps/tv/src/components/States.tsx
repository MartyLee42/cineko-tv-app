import { ApiError } from "@martytv/contracts";
import { CV_ERROR, CV_OFFLINE, useAppliedDesign, useI18n } from "@martytv/ui";
import { FocusButton } from "../focus";

/** Grey placeholder blocks while a row loads. */
export function RowSkeleton({ count = 7, width = 260, height = 390, title = true }: { count?: number; width?: number; height?: number; title?: boolean }) {
  return (
    <div>
      {title && <div className="mb-8 h-9 w-96 rounded-lg bg-surface-2 tv-pulse" />}
      <div className="flex overflow-hidden">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="mr-7 shrink-0 rounded-2xl bg-surface tv-pulse" style={{ width, height }} />
        ))}
      </div>
    </div>
  );
}

export function GridSkeleton({ cols, rows = 2, width, height, pitchX, pitchY }: { cols: number; rows?: number; width: number; height: number; pitchX: number; pitchY: number }) {
  return (
    <div className="relative" style={{ height: rows * pitchY }}>
      {Array.from({ length: cols * rows }, (_, i) => (
        <div
          key={i}
          className="absolute rounded-2xl bg-surface tv-pulse"
          style={{ width, height, left: (i % cols) * pitchX, top: Math.floor(i / cols) * pitchY }}
        />
      ))}
    </div>
  );
}

/** Error with a focusable Retry button (TMDB not configured has no retry). */
export function ErrorState({
  error,
  unavailable,
  onRetry,
  focusKey,
  className = "",
  autoFocus = true,
}: {
  error: unknown;
  unavailable?: boolean;
  onRetry: () => void;
  focusKey: string;
  className?: string;
  /** Move focus to Retry (off while the user is typing a search). */
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const cv = useAppliedDesign() === "constructivism";
  if (unavailable) {
    return (
      <div className={`max-w-[1200px] ${className}`}>
        <p className="text-5xl font-bold">{t("catalog.tv.unavailable_title")}</p>
        <p className="mt-6 text-3xl leading-snug text-muted">{t("catalog.unavailable")}</p>
      </div>
    );
  }
  const offline = error instanceof ApiError && error.code === "network_error";
  return (
    <div className={`max-w-[1200px] ${className}`}>
      <p className="text-4xl font-semibold">{cv ? (offline ? CV_OFFLINE : CV_ERROR) : offline ? t("tv.offline") : t("catalog.tv.load_error")}</p>
      <div className="mt-10 flex">
        <FocusButton focusKey={focusKey} onPress={onRetry} autoFocus={autoFocus} className="rounded-2xl bg-accent px-10 py-5 text-3xl font-semibold text-on-accent">
          {t("common.retry")}
        </FocusButton>
      </div>
    </div>
  );
}

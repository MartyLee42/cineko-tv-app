import { useId, useMemo, useState } from "react";
import { useI18n } from "@martytv/ui";
import { buildPath, chartPoints, nearest, type ChartPoint } from "./chart";

export interface Series {
  label: string;
  values: { t: string; v: number }[];
  /** CSS colour, e.g. "rgb(var(--mt-accent))". */
  color: string;
  dashed?: boolean;
}

interface Props {
  title: string;
  /** Current value shown next to the title. */
  current?: string;
  series: Series[];
  max: number;
  format: (v: number) => string;
  /** Dashed horizontal reference line (e.g. the core count on the load chart). */
  reference?: { value: number; label: string };
  endMs: number;
  minutes: number;
  testId?: string;
}

const W = 300;
const H = 100;

/** One-hour line chart: fixed time window, labelled y (0 and max) and x
 * (−60 min … now) axes, crosshair tooltip on hover/touch. One y-scale only. */
export function HistoryChart({ title, current, series, max, format, reference, endMs, minutes, testId }: Props) {
  const { t, locale } = useI18n();
  const clipId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const pts = useMemo(() => series.map((s) => chartPoints(s.values, endMs, minutes, max)), [series, endMs, minutes, max]);
  const first = pts[0] ?? [];
  const idx = hover == null ? -1 : nearest(first, hover);
  const hp: ChartPoint | undefined = first[idx];
  const time = (ms: number) => new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width > 0) setHover(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
  };

  return (
    <figure className="min-w-0" data-testid={testId}>
      <figcaption className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        {current && <span className="text-sm tabular-nums text-muted">{current}</span>}
      </figcaption>
      {series.length > 1 && (
        <div className="mb-1 flex flex-wrap gap-3 text-xs text-muted">
          {series.map((s) => (
            <span key={s.label} className="inline-flex items-center gap-1.5">
              <svg width="16" height="6" aria-hidden>
                <line x1="0" y1="3" x2="16" y2="3" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? "4 3" : undefined} />
              </svg>
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        {/* y axis: max at the top, 0 at the bottom */}
        <div className="flex h-24 min-w-[2.75rem] shrink-0 flex-col justify-between whitespace-nowrap text-right text-[10px] leading-none tabular-nums text-muted">
          <span>{format(max)}</span>
          <span>{format(max / 2)}</span>
          <span>0</span>
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="relative h-24 touch-pan-y"
            onPointerMove={move}
            onPointerDown={move}
            onPointerLeave={() => setHover(null)}
          >
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" role="img" aria-label={title}>
              <defs>
                <clipPath id={clipId}>
                  <rect x="0" y="-2" width={W} height={H + 4} />
                </clipPath>
              </defs>
              {[0, 0.5, 1].map((g) => (
                <line key={g} x1="0" x2={W} y1={g * H} y2={g * H} stroke="rgb(var(--mt-border))" strokeWidth="1" vectorEffect="non-scaling-stroke" opacity={g === 1 ? 1 : 0.5} />
              ))}
              {reference && reference.value <= max && (
                <line
                  x1="0"
                  x2={W}
                  y1={(1 - reference.value / max) * H}
                  y2={(1 - reference.value / max) * H}
                  stroke="rgb(var(--mt-muted))"
                  strokeWidth="1"
                  strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <g clipPath={`url(#${clipId})`}>
                {series.length === 1 && <Area points={first} color={series[0]!.color} />}
                {series.map((s, i) => (
                  <path
                    key={s.label}
                    d={buildPath(pts[i] ?? [], W, H)}
                    fill="none"
                    stroke={s.color}
                    strokeWidth="2"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    strokeDasharray={s.dashed ? "5 4" : undefined}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </g>
              {hp && (
                <line x1={hp.x * W} x2={hp.x * W} y1="0" y2={H} stroke="rgb(var(--mt-muted))" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              )}
            </svg>
            {hp &&
              pts.map((p, i) => {
                const q = p[idx];
                return q ? (
                  <span
                    key={i}
                    className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface"
                    style={{ left: `${q.x * 100}%`, top: `${q.y * 100}%`, background: series[i]!.color }}
                  />
                ) : null;
              })}
            {reference && reference.value <= max && (
              <span
                className="pointer-events-none absolute left-1 -translate-y-full rounded bg-surface/80 px-1 pb-0.5 text-[10px] leading-none text-muted"
                style={{ top: `${(1 - reference.value / max) * 100}%` }}
              >
                {reference.label}
              </span>
            )}
            {hp && (
              <div
                className="pointer-events-none absolute top-0 z-10 rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs shadow-lg"
                style={hp.x > 0.6 ? { right: `${(1 - hp.x) * 100 + 2}%` } : { left: `${hp.x * 100 + 2}%` }}
                role="tooltip"
              >
                <div className="text-muted">{time(hp.t)}</div>
                {series.map((s, i) => {
                  const q = pts[i]?.[idx];
                  return q ? (
                    <div key={s.label} className="whitespace-nowrap tabular-nums">
                      {series.length > 1 && <span className="text-muted">{s.label}: </span>}
                      {format(q.v)}
                    </div>
                  ) : null;
                })}
              </div>
            )}
          </div>
          <div className="mt-1 flex justify-between text-[10px] leading-none text-muted">
            <span>{t("admin.server.minutes_ago", { n: minutes })}</span>
            <span>{t("admin.server.minutes_ago", { n: minutes / 2 })}</span>
            <span>{t("admin.server.now")}</span>
          </div>
        </div>
      </div>
    </figure>
  );
}

function Area({ points, color }: { points: ChartPoint[]; color: string }) {
  // One filled polygon per unbroken segment.
  const segs: ChartPoint[][] = [];
  for (const p of points) {
    if (!segs.length || p.gap) segs.push([]);
    segs[segs.length - 1]!.push(p);
  }
  return (
    <>
      {segs
        .filter((s) => s.length > 1)
        .map((s, i) => (
          <path
            key={i}
            d={`${buildPath(s, W, H)}L${(s[s.length - 1]!.x * W).toFixed(1)},${H}L${(s[0]!.x * W).toFixed(1)},${H}Z`}
            fill={color}
            opacity="0.12"
            stroke="none"
          />
        ))}
    </>
  );
}

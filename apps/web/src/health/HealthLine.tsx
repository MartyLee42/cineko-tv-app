// «Состояние» of a TV (Devices page, Admin → Устройства): the newest health
// report as one compact line, bad values in the warning colour with a hint,
// and a tiny fps sparkline over the recent reports. A TV without a recent
// report shows «не отправляет» instead of stale numbers.
import { useQuery } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@martytv/contracts";
import { healthHints, healthParts, healthSeries, healthStale, sparkPoints, useI18n } from "@martytv/ui";
import { api } from "../api";
import { timeAgo } from "../components";

export type DeviceHealth = Schemas["DeviceHealth"];

export const deviceHealthKey = (id: string) => ["devices", id, "health"] as const;

export function useDeviceHealth(deviceId: string) {
  return useQuery({
    queryKey: deviceHealthKey(deviceId),
    queryFn: () => unwrap(api.GET("/devices/{id}/health", { params: { path: { id: deviceId } } })),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
}

export function HealthLine({ deviceId, className = "" }: { deviceId: string; className?: string }) {
  const { t, locale } = useI18n();
  const { data, error, dataUpdatedAt } = useDeviceHealth(deviceId);
  if (error || !data) return null;
  const latest = data.latest;
  const label = <span className="text-muted">{t("health.title")}: </span>;
  if (!latest || healthStale(latest.at, dataUpdatedAt)) {
    return (
      <p className={`text-xs text-muted ${className}`} data-testid="device-health" data-state="silent">
        {label}
        {latest ? `${t("health.not_sending")} · ${t("health.last", { when: timeAgo(latest.at, locale) })}` : t("health.none")}
      </p>
    );
  }
  const parts = healthParts(latest, t, locale);
  const hints = healthHints(latest);
  const fps = healthSeries(data.history, "fps");
  const points = sparkPoints(fps, 48, 12);
  return (
    <div className={`text-xs ${className}`} data-testid="device-health" data-state="ok">
      <p className="flex flex-wrap items-center gap-x-1">
        {label}
        {parts.map((p, i) => (
          <span key={p.id} data-health={p.id} data-bad={p.bad ? "1" : undefined} className={p.bad ? "font-medium text-warn" : "text-text/80"}>
            {i > 0 && <span className="text-muted"> · </span>}
            {p.text}
          </span>
        ))}
        <span className="text-muted"> · {timeAgo(latest.at, locale)}</span>
        {points && (
          <svg
            width={48}
            height={12}
            viewBox="-1 -1 50 14"
            className="ml-1 inline-block text-accent"
            role="img"
            aria-label={t("health.range", { min: Math.round(Math.min(...fps)), max: Math.round(Math.max(...fps)), n: fps.length })}
          >
            <title>{t("health.range", { min: Math.round(Math.min(...fps)), max: Math.round(Math.max(...fps)), n: fps.length })}</title>
            <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
          </svg>
        )}
      </p>
      {hints.map((h) => (
        <p key={h} className="text-warn">
          {t(h)}
        </p>
      ))}
    </div>
  );
}

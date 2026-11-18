// Admin → «Качество»: how playback went lately, from the players' own
// measurements (server: internal/watch/quality.go).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@martytv/contracts";
import { Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { api } from "../api";
import { Card, ErrorText } from "../components";
import { Tabs } from "../catalog/components";

type Report = Schemas["PlaybackQualityReport"];
const RANGES = ["7", "30", "90"] as const;
const one = (n: number) => (Math.round(n * 10) / 10).toString();

export function QualityTab() {
  const { t, locale } = useI18n();
  const [days, setDays] = useState<(typeof RANGES)[number]>("7");
  const q = useQuery({
    queryKey: ["admin", "playback-quality", days, locale],
    queryFn: () => unwrap(api.GET("/admin/playback-quality", { params: { query: { days: Number(days), lang: locale === "en" ? "en" : "ru" } } })) as Promise<Report>,
    refetchInterval: 60_000,
  });
  const kind = (k: string) =>
    t((["torrent", "online", "anime"].includes(k) ? `admin.quality.kind.${k}` : "admin.quality.kind.other") as MessageKey);
  const app = (a: string) => (a === "tv" ? "TV" : t("admin.quality.app.web"));
  const span = (s: number) =>
    s >= 3600 ? t("admin.quality.hours", { h: one(s / 3600) }) : t("admin.quality.minutes", { m: Math.round(s / 60) });
  const groups = q.data?.groups ?? [];
  const worst = q.data?.worst ?? [];
  return (
    <div className="space-y-4" data-testid="quality-tab">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{t("admin.quality.title")}</h2>
            <p className="mt-1 text-sm text-muted">{t("admin.quality.hint")}</p>
          </div>
          <Tabs
            value={days}
            onChange={setDays}
            label={t("admin.quality.title")}
            options={RANGES.map((n) => ({ value: n, label: t("admin.quality.days", { n }) }))}
          />
        </div>
        <ErrorText error={q.error} />
        {q.isPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : groups.length === 0 ? (
          <p className="mt-4 text-sm text-muted">{t("admin.quality.empty")}</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm" data-testid="quality-groups">
              <thead className="text-xs text-muted">
                <tr>
                  {(["group", "sessions", "watched", "smooth", "stalls_h", "stall_pct", "dropped", "startup"] as const).map((k) => (
                    <th key={k} className="pb-2 pr-4 font-medium">
                      {t(`admin.quality.${k}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {groups.map((g) => (
                  <tr key={`${g.app}-${g.source_kind}`} className="border-t border-border">
                    <td className="py-2 pr-4 font-medium">
                      {app(g.app)} · {kind(g.source_kind)}
                    </td>
                    <td className="pr-4">{g.sessions}</td>
                    <td className="pr-4">{span(g.watched_s)}</td>
                    <td className="pr-4">{Math.round(g.smooth_pct)}%</td>
                    <td className="pr-4">{one(g.stalls_per_hour)}</td>
                    <td className="pr-4">{one(g.stall_pct)}%</td>
                    <td className="pr-4">{g.dropped_pct == null ? "—" : `${one(g.dropped_pct)}%`}</td>
                    <td>{g.median_startup_s == null ? "—" : `${one(g.median_startup_s)} s`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {!q.isPending && groups.length > 0 && (
        <Card>
          <h2 className="text-lg font-semibold">{t("admin.quality.worst")}</h2>
          {worst.length === 0 ? (
            <p className="mt-2 text-sm text-muted">{t("admin.quality.no_worst")}</p>
          ) : (
            <ul className="mt-3 divide-y divide-border" data-testid="quality-worst">
              {worst.map((r) => (
                <li key={r.id} className="py-2.5 text-sm">
                  <p className="truncate font-medium">{r.title}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {[
                      new Date(r.updated_at).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }),
                      r.device ?? app(r.app),
                      r.provider ?? kind(r.source_kind),
                      r.engine,
                      r.height ? `${r.height}p` : null,
                      span(r.watched_s),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <p className="mt-0.5 text-xs tabular-nums">
                    {[
                      r.stalls > 0 ? t("admin.quality.stalls", { n: r.stalls, s: one(r.stall_s), l: one(r.longest_stall_s) }) : null,
                      r.dropped_pct != null && r.dropped_pct >= 2 ? t("admin.quality.dropped_n", { p: one(r.dropped_pct) }) : null,
                      r.startup_s != null ? t("admin.quality.startup_n", { s: one(r.startup_s) }) : null,
                      r.errors > 0 ? t("admin.quality.errors", { n: r.errors }) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { unwrap, type Schemas } from "@martytv/contracts";
import { Spinner, StatusDot, useI18n, type MessageKey } from "@martytv/ui";
import { api } from "../api";
import { Card, ErrorText } from "../components";
import { HistoryChart } from "./HistoryChart";
import { AdminVideoCard } from "../video/AdminVideoCard";
import {
  cpuLevel,
  diskLevel,
  formatBytes,
  formatLoad,
  formatPercent,
  formatRate,
  formatUptime,
  loadLevel,
  niceMax,
  percentOf,
  ramLevel,
  swapLevel,
  type Level,
} from "./format";

type SystemStatus = Schemas["SystemStatus"];
type SystemHistory = Schemas["SystemHistory"];

const ACCENT = "rgb(var(--mt-accent))";
const NEUTRAL = "rgba(var(--mt-text), 0.75)";
const HISTORY_MINUTES = 60;

/** Admin → Server: host load, history charts, containers, processes, app
 * and TorrServer stats. Polls every 5 s while mounted and the page is
 * visible (react-query pauses intervals in background tabs). */
export function ServerTab() {
  const { t } = useI18n();
  const status = useQuery({
    queryKey: ["admin", "system"],
    queryFn: () => unwrap(api.GET("/admin/system")),
    refetchInterval: 5000,
  });
  const history = useQuery({
    queryKey: ["admin", "system", "history"],
    queryFn: () => unwrap(api.GET("/admin/system/history", { params: { query: { minutes: HISTORY_MINUTES } } })),
    refetchInterval: 10_000,
  });
  const s = status.data;

  if (status.isPending) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }
  if (!s) return <ErrorText error={status.error} />;

  return (
    <div className="space-y-4" data-testid="server-tab">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="rounded-full bg-surface-2 px-2.5 py-1 font-medium text-text" data-testid="server-scope">
          {t(s.scope === "host" ? "admin.server.scope_host" : "admin.server.scope_container")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <StatusDot online={!status.isError} />
          {t("admin.server.live")}
        </span>
      </div>
      {s.hostmon !== "ok" && (
        <p className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-sm" data-testid="hostmon-missing">
          {t("admin.server.hostmon_missing")}
        </p>
      )}
      <ErrorText error={status.error} />
      <Tiles s={s} />
      <Charts s={s} h={history.data} />
      <div className="grid gap-4 lg:grid-cols-2">
        <AppPanel app={s.app} />
        <TorrServerPanel ts={s.app.torrserver} />
        <AdminVideoCard />
      </div>
      {s.containers.length > 0 && <ContainersTable s={s} />}
      <ProcessesTable s={s} />
    </div>
  );
}

// ---------------------------------------------------------------- tiles

const LEVEL_STYLE: Record<Level, { bar: string; badge: string; key?: MessageKey; icon?: string }> = {
  ok: { bar: "bg-accent", badge: "" },
  warn: { bar: "bg-warn", badge: "bg-warn/15 text-warn", key: "admin.server.level.warn", icon: "▲" },
  crit: { bar: "bg-danger", badge: "bg-danger/15 text-danger", key: "admin.server.level.crit", icon: "■" },
};

function Tile({
  label,
  value,
  detail,
  meter,
  lvl = "ok",
  testId,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  meter?: number;
  lvl?: Level;
  testId?: string;
}) {
  const { t } = useI18n();
  const st = LEVEL_STYLE[lvl];
  return (
    <div
      className={`min-w-0 rounded-2xl border bg-surface p-3 sm:p-4 ${lvl === "crit" ? "border-danger/60" : lvl === "warn" ? "border-warn/60" : "border-border"}`}
      data-testid={testId}
      data-level={lvl}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
        {st.key && (
          <span className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold ${st.badge}`}>
            <span aria-hidden>{st.icon} </span>
            {t(st.key)}
          </span>
        )}
      </div>
      <div className="mt-1 truncate text-2xl font-semibold tabular-nums">{value}</div>
      {meter != null && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" role="meter" aria-valuenow={Math.round(meter)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
          <div className={`h-full rounded-full ${st.bar}`} style={{ width: `${Math.max(1, Math.min(100, meter))}%` }} />
        </div>
      )}
      {detail && <div className="mt-1.5 truncate text-xs text-muted">{detail}</div>}
    </div>
  );
}

function Tiles({ s }: { s: SystemStatus }) {
  const { t, locale } = useI18n();
  const b = (n: number) => formatBytes(n, locale);
  const m = s.memory;
  const rx = s.network.reduce((a, n) => a + n.rx_bps, 0);
  const tx = s.network.reduce((a, n) => a + n.tx_bps, 0);
  const [l1, l5, l15] = s.load_avg;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="server-tiles">
      <Tile
        testId="tile-cpu"
        label={t("admin.server.cpu")}
        value={formatPercent(s.cpu.usage_percent, locale)}
        meter={s.cpu.usage_percent}
        lvl={cpuLevel(s.cpu.usage_percent)}
        detail={t("admin.server.cpu_detail", {
          cores: s.cpu.cores,
          steal: formatPercent(s.cpu.steal_percent, locale),
          iowait: formatPercent(s.cpu.iowait_percent, locale),
        })}
      />
      <Tile
        testId="tile-ram"
        label={t("admin.server.ram")}
        value={formatPercent(percentOf(m.used, m.total), locale)}
        meter={percentOf(m.used, m.total)}
        lvl={ramLevel(m.used, m.total)}
        detail={t("admin.server.ram_detail", { used: b(m.used), total: b(m.total), cached: b(m.cached) })}
      />
      <Tile
        testId="tile-swap"
        label={t("admin.server.swap")}
        value={m.swap_total > 0 ? formatPercent(percentOf(m.swap_used, m.swap_total), locale) : "—"}
        meter={m.swap_total > 0 ? percentOf(m.swap_used, m.swap_total) : undefined}
        lvl={swapLevel(m.swap_used, m.swap_total)}
        detail={m.swap_total > 0 ? t("admin.server.swap_detail", { used: b(m.swap_used), total: b(m.swap_total) }) : t("admin.server.no_swap")}
      />
      <Tile
        testId="tile-load"
        label={t("admin.server.load")}
        value={
          <>
            {formatLoad(l1 ?? 0, locale)}
            <span className="text-base font-normal text-muted">
              {" "}
              / {formatLoad(l5 ?? 0, locale)} / {formatLoad(l15 ?? 0, locale)}
            </span>
          </>
        }
        meter={s.cpu.cores ? percentOf(l1 ?? 0, s.cpu.cores) : undefined}
        lvl={loadLevel(l1 ?? 0, s.cpu.cores)}
        detail={t("admin.server.load_detail", { cores: s.cpu.cores })}
      />
      {s.disks.map((d) => (
        <Tile
          key={d.mount}
          testId="tile-disk"
          label={t("admin.server.disk", { mount: d.mount })}
          value={formatPercent(percentOf(d.used, d.total), locale)}
          meter={percentOf(d.used, d.total)}
          lvl={diskLevel(d.used, d.total)}
          detail={t("admin.server.disk_detail", { free: b(d.free), total: b(d.total) })}
        />
      ))}
      <Tile
        testId="tile-net"
        label={t("admin.server.network")}
        value={
          <span className="flex flex-col text-lg leading-tight">
            <span>↓ {formatRate(rx, locale)}</span>
            <span className="text-muted">↑ {formatRate(tx, locale)}</span>
          </span>
        }
        detail={s.network.map((n) => n.iface).join(", ") || "—"}
      />
      <Tile testId="tile-uptime" label={t("admin.server.uptime")} value={formatUptime(s.uptime_seconds, locale)} />
    </div>
  );
}

// ---------------------------------------------------------------- charts

function Charts({ s, h }: { s: SystemStatus; h?: SystemHistory }) {
  const { t, locale } = useI18n();
  // Charts end at the latest snapshot ("now"), so stale history shows as a gap.
  const endMs = Date.parse(s.collected_at);
  const series = useMemo(() => {
    const samples = h?.samples ?? [];
    const pick = (f: (x: SystemHistory["samples"][number]) => number | null) =>
      samples.flatMap((x) => {
        const v = f(x);
        return v == null ? [] : [{ t: x.t, v }];
      });
    return {
      cpu: pick((x) => x.cpu_percent),
      mem: pick((x) => x.mem_used),
      load: pick((x) => x.load1),
      rx: pick((x) => x.rx_bps),
      tx: pick((x) => x.tx_bps),
      streams: pick((x) => x.active_streams),
    };
  }, [h]);
  const cores = h?.cores || s.cpu.cores;
  const memTotal = h?.mem_total || s.memory.total;
  const maxOf = (vs: { v: number }[]) => vs.reduce((a, x) => Math.max(a, x.v), 0);
  const netMax = niceMax(Math.max(maxOf(series.rx), maxOf(series.tx)));
  const loadMax = niceMax(Math.max(cores, maxOf(series.load)));
  const streamMax = Math.max(2, niceMax(maxOf(series.streams)));
  const rx = s.network.reduce((a, n) => a + n.rx_bps, 0);
  const tx = s.network.reduce((a, n) => a + n.tx_bps, 0);
  const common = { endMs, minutes: HISTORY_MINUTES };
  const b = (n: number) => formatBytes(n, locale);

  return (
    <Card className="space-y-4">
      <h2 className="font-semibold">{t("admin.server.last_hour")}</h2>
      {(h?.samples.length ?? 0) < 2 && <p className="text-sm text-muted">{t("admin.server.collecting")}</p>}
      <div className="grid gap-x-6 gap-y-5 md:grid-cols-2" data-testid="server-charts">
        <HistoryChart
          {...common}
          testId="chart-cpu"
          title={`${t("admin.server.chart.cpu")}, %`}
          current={formatPercent(s.cpu.usage_percent, locale)}
          series={[{ label: t("admin.server.chart.cpu"), values: series.cpu, color: ACCENT }]}
          max={100}
          format={(v) => formatPercent(v, locale)}
        />
        <HistoryChart
          {...common}
          testId="chart-ram"
          title={t("admin.server.chart.ram")}
          current={`${b(s.memory.used)} / ${b(memTotal)}`}
          series={[{ label: t("admin.server.chart.ram"), values: series.mem, color: ACCENT }]}
          max={memTotal}
          format={(v) => (v === 0 ? "0" : b(v))}
        />
        <HistoryChart
          {...common}
          testId="chart-load"
          title={t("admin.server.chart.load")}
          current={formatLoad(s.load_avg[0] ?? 0, locale)}
          series={[{ label: t("admin.server.chart.load"), values: series.load, color: ACCENT }]}
          max={loadMax}
          format={(v) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(v)}
          reference={{ value: cores, label: t("admin.server.cores_line", { n: cores }) }}
        />
        <HistoryChart
          {...common}
          testId="chart-net"
          title={t("admin.server.chart.net")}
          current={`↓ ${formatRate(rx, locale)} · ↑ ${formatRate(tx, locale)}`}
          series={[
            { label: `↓ ${t("admin.server.download")}`, values: series.rx, color: ACCENT },
            { label: `↑ ${t("admin.server.upload")}`, values: series.tx, color: NEUTRAL, dashed: true },
          ]}
          max={netMax}
          format={(v) => formatRate(v, locale)}
        />
        <HistoryChart
          {...common}
          testId="chart-streams"
          title={t("admin.server.chart.streams")}
          current={String(s.app.active_streams)}
          series={[{ label: t("admin.server.chart.streams"), values: series.streams, color: ACCENT }]}
          max={streamMax}
          format={(v) => String(Math.round(v * 10) / 10)}
        />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- panels

function Stat({ label, value, testId }: { label: string; value: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <dt className="truncate text-xs text-muted">{label}</dt>
      <dd className="truncate font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function AppPanel({ app }: { app: SystemStatus["app"] }) {
  const { t, locale } = useI18n();
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">{t("admin.server.app")}</h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3" data-testid="app-panel">
        <Stat label={t("admin.server.streams_now")} value={app.active_streams} testId="app-streams" />
        {app.transcoder && (
          <Stat
            label={t("admin.server.transcoder")}
            value={app.transcoder.ok ? t("admin.server.transcoder_value", { active: app.transcoder.active_jobs, max: app.transcoder.max_jobs }) : t("admin.server.transcoder_down")}
            testId="app-transcoder"
          />
        )}
        <Stat label={t("admin.server.online")} value={t("admin.server.online_value", { users: app.ws_connections.users, devices: app.ws_connections.devices })} />
        <Stat label={t("admin.server.db_size")} value={formatBytes(app.db_size_bytes, locale)} />
        <Stat label={t("admin.server.image_cache")} value={formatBytes(app.image_cache_bytes, locale)} />
        <Stat label={t("admin.server.go_heap")} value={formatBytes(app.go_heap_bytes, locale)} />
        <Stat label={t("admin.server.goroutines")} value={app.go_routines} />
        <Stat label={t("admin.server.version")} value={<span className="font-mono text-sm font-normal">{app.martytv_version}</span>} />
      </dl>
      {app.integrations.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-xs">
          {app.integrations.map((i) => (
            <span key={i.name} className="inline-flex items-center gap-1.5">
              <StatusDot online={i.ok} />
              <span className="capitalize">{i.name}</span>
              {!i.configured && <span className="text-muted">({t("admin.not_configured")})</span>}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

function TorrServerPanel({ ts }: { ts: SystemStatus["app"]["torrserver"] }) {
  const { t, locale } = useI18n();
  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold">{t("admin.server.torrserver")}</h2>
        {ts.configured && <StatusDot online={ts.ok} />}
        <span className="text-xs text-muted">
          {!ts.configured ? t("admin.not_configured") : ts.ok ? ts.version : t("admin.server.unavailable")}
        </span>
      </div>
      {ts.ok && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3" data-testid="torrserver-panel">
          <Stat label={t("admin.server.torrents")} value={ts.torrents} />
          <Stat label={t("admin.server.active")} value={ts.active} />
          <Stat label={t("admin.server.peers")} value={ts.peers} />
          <Stat label={`↓ ${t("admin.server.download")}`} value={formatRate(ts.download_speed_bps, locale)} />
          <Stat label={`↑ ${t("admin.server.upload")}`} value={formatRate(ts.upload_speed_bps, locale)} />
        </dl>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- tables

function Table({ head, children, testId }: { head: ReactNode[]; children: ReactNode; testId?: string }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <table className="w-full text-sm" data-testid={testId}>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted">
            {head.map((h, i) => (
              <th key={i} className={`py-1.5 font-medium ${i === 1 ? "w-16 pl-3 text-right sm:w-24" : i === 2 ? "w-36 pl-3 text-right sm:w-60" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">{children}</tbody>
      </table>
    </div>
  );
}

/** Inline bar behind a number: share of the biggest row. */
function Bar({ pct }: { pct: number }) {
  return (
    <span className="ml-2 hidden h-1.5 w-16 overflow-hidden rounded-full bg-surface-2 align-middle sm:inline-block">
      <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
    </span>
  );
}

function ContainersTable({ s }: { s: SystemStatus }) {
  const { t, locale } = useI18n();
  const top = Math.max(1, ...s.containers.map((c) => c.mem_bytes));
  return (
    <Card className="space-y-2">
      <h2 className="font-semibold">{t("admin.server.containers")}</h2>
      <Table testId="containers-table" head={[t("admin.server.col.name"), t("admin.server.col.cpu"), t("admin.server.col.memory")]}>
        {s.containers.map((c) => (
          <tr key={c.name} className={c.state === "running" ? "" : "text-muted"}>
            <td className="max-w-0 py-1.5">
              <div className="flex items-center gap-2">
                <StatusDot online={c.state === "running"} />
                <span className="truncate">{c.name}</span>
                {c.state !== "running" && <span className="shrink-0 text-xs">{c.state}</span>}
              </div>
            </td>
            <td className="whitespace-nowrap py-1.5 pl-3 text-right tabular-nums">{c.state === "running" ? formatPercent(c.cpu_percent, locale) : "—"}</td>
            <td className="whitespace-nowrap py-1.5 pl-3 text-right tabular-nums">
              {c.state === "running" ? formatBytes(c.mem_bytes, locale) : "—"}
              {c.mem_limit_bytes > 0 && c.state === "running" && (
                <span className="text-xs text-muted"> {t("admin.server.of_limit", { limit: formatBytes(c.mem_limit_bytes, locale) })}</span>
              )}
              <Bar pct={(c.mem_bytes / top) * 100} />
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

function ProcessesTable({ s }: { s: SystemStatus }) {
  const { t, locale } = useI18n();
  const top = Math.max(1, ...s.processes.map((p) => p.rss_bytes));
  return (
    <Card className="space-y-2">
      <div>
        <h2 className="font-semibold">{t("admin.server.processes")}</h2>
        <p className="text-xs text-muted">{t("admin.server.processes_hint")}</p>
      </div>
      <Table testId="processes-table" head={[t("admin.server.col.name"), t("admin.server.col.cpu"), t("admin.server.col.memory")]}>
        {s.processes.map((p) => (
          <tr key={p.name}>
            <td className="max-w-0 py-1.5">
              <span className="block truncate">
                {p.name}
                {p.count > 1 && <span className="text-xs text-muted"> ×{p.count}</span>}
              </span>
            </td>
            <td className="whitespace-nowrap py-1.5 pl-3 text-right tabular-nums">{formatPercent(p.cpu_percent, locale)}</td>
            <td className="whitespace-nowrap py-1.5 pl-3 text-right tabular-nums">
              {formatBytes(p.rss_bytes, locale)}
              <Bar pct={(p.rss_bytes / top) * 100} />
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

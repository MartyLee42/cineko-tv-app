// Admin → IPTV: playlists (iptv-org country presets, M3U links, uploaded
// M3U files), refresh status, channel counts, EPG coverage, offline count.
import { useState } from "react";
import { ApiError, type Schemas } from "@martytv/contracts";
import { Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { Button, Card, ErrorText, Field, fieldErrors, Input, timeAgo } from "../components";
import { RefreshIcon } from "../icons";
import { Sheet } from "../remote/SendToTv";
import { coverage } from "../iptv/logic";
import { useAdminIptv, useAdminPlaylists, useIptvCountries, type AdminPlaylist, type PlaylistInput } from "../iptv/queries";

type Kind = AdminPlaylist["kind"];
const KINDS: Kind[] = ["iptv_org_country", "m3u_url", "m3u_file"];

export function IptvTab() {
  const { t } = useI18n();
  const q = useAdminPlaylists();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AdminPlaylist | null>(null);
  if (q.isPending) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }
  const d = q.data;
  return (
    <div className="space-y-4" data-testid="admin-iptv">
      <ErrorText error={q.error} />
      {d && (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">{t("iptv.admin.totals")}</h2>
            <Button onClick={() => setAdding(true)} data-testid="iptv-add">
              + {t("iptv.admin.add")}
            </Button>
          </div>
          <Stats s={d.totals} testId="iptv-totals" />
          <p className="text-sm text-muted">
            {d.proxy_configured ? t("iptv.admin.proxy_on") : t("iptv.admin.proxy_off")}{" "}
            {t("iptv.admin.schedule", { hours: d.refresh_hours, epg: d.epg_refresh_hours })}
          </p>
        </Card>
      )}
      {d?.items.length === 0 && <p className="rounded-2xl border border-dashed border-border p-6 text-center text-muted">{t("iptv.admin.empty")}</p>}
      {d?.items.map((p) => <PlaylistCard key={p.id} p={p} onEdit={() => setEditing(p)} />)}
      {adding && <AddSheet existing={d?.items ?? []} proxy={!!d?.proxy_configured} onClose={() => setAdding(false)} />}
      {editing && <EditSheet p={editing} proxy={!!d?.proxy_configured} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Stats({ s, testId }: { s: AdminPlaylist["stats"]; testId?: string }) {
  const { t } = useI18n();
  const tiles: [MessageKey, number | string][] = [
    ["iptv.admin.channels", s.channels],
    ["iptv.admin.offline", s.offline],
    ["iptv.admin.epg_matched", s.epg_matched],
    ["iptv.admin.with_programmes", s.with_programmes],
  ];
  return (
    <div data-testid={testId}>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map(([k, v]) => (
          <div key={k} className="rounded-xl bg-bg/50 px-3 py-2">
            <dt className="text-xs text-muted">{t(k)}</dt>
            <dd className={`text-lg font-bold tabular-nums ${k === "iptv.admin.offline" && Number(v) > 0 ? "text-danger" : ""}`}>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-1.5 text-xs text-muted">{t("iptv.admin.coverage", { percent: coverage(s) })}</p>
    </div>
  );
}

const STATUS_CLS: Record<string, string> = {
  ok: "bg-ok/15 text-ok",
  error: "bg-danger/15 text-danger",
  running: "bg-accent/15 text-accent",
  never: "bg-surface-2 text-muted",
  none: "bg-surface-2 text-muted",
};

function StatusLine({ label, status, error, at, extra }: { label: string; status: string; error: string | null; at: string | null; extra?: string }) {
  const { t, locale } = useI18n();
  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-28 shrink-0 text-muted">{label}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLS[status] ?? STATUS_CLS.never}`} data-testid="iptv-status" data-status={status}>
          {status === "running" && <Spinner size={10} />} {t(`iptv.admin.status.${status}` as MessageKey)}
        </span>
        {at && <span className="text-muted">{timeAgo(at, locale)}</span>}
        {extra && <span className="text-muted">· {extra}</span>}
      </div>
      {error && <p className="mt-1 break-words rounded-lg bg-danger/10 px-2 py-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

type Guide = Schemas["IptvGuideState"];

const mbs = (n: number) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;

/** The playlist's XMLTV guides in merge order (first match wins). */
function GuideList({ guides }: { guides: Guide[] }) {
  const { t } = useI18n();
  if (!guides.length) return null;
  return (
    <ol className="space-y-1 pl-0 text-xs text-muted sm:pl-[7.5rem]" data-testid="iptv-guides">
      {guides.map((g, i) => {
        const host = (() => {
          try {
            return new URL(g.url).host;
          } catch {
            return g.url;
          }
        })();
        const p = g.progress;
        return (
          <li key={g.url} className="min-w-0" data-testid="iptv-guide" data-status={g.status}>
            <div className="flex flex-wrap items-center gap-x-2">
              <span className="font-semibold text-text">{i + 1}.</span>
              <span className="truncate" title={g.url}>{host}</span>
              <span className={`rounded-full px-1.5 py-px font-semibold ${STATUS_CLS[g.status] ?? STATUS_CLS.never}`}>{t(`iptv.admin.status.${g.status}` as MessageKey)}</span>
              {p ? (
                <span>
                  {t(`iptv.admin.guide_phase.${p.phase}` as MessageKey)} {mbs(p.bytes)}
                  {p.total > 0 ? ` / ${mbs(p.total)}` : ""}
                </span>
              ) : (
                g.status === "ok" && (
                  <span>{t("iptv.admin.guide_stats", { size: mbs(g.bytes), seconds: Math.round(g.took_ms / 1000), matched: g.matched, programmes: g.programmes })}</span>
                )
              )}
              {g.fetched_via === "proxy" && <span className="text-accent">proxy</span>}
            </div>
            {g.error && <p className="break-words text-danger">{g.error}</p>}
          </li>
        );
      })}
    </ol>
  );
}

function PlaylistCard({ p, onEdit }: { p: AdminPlaylist; onEdit: () => void }) {
  const { t } = useI18n();
  const { update, remove, refresh, upload } = useAdminIptv();
  const [err, setErr] = useState<unknown>(null);
  const running = p.refresh.status === "running" || p.epg.status === "running";
  const via = p.refresh.fetched_via ? t(`iptv.admin.fetched_via.${p.refresh.fetched_via}` as MessageKey) : undefined;
  const doRefresh = () =>
    refresh.mutate(p.id, {
      onError: (e) => setErr(e instanceof ApiError && e.status === 409 ? new Error(t("iptv.admin.refresh_running")) : e),
      onSuccess: () => setErr(null),
    });
  return (
    <Card className={`space-y-3 ${p.enabled ? "" : "opacity-70"}`}>
      <div data-testid="iptv-playlist" data-playlist-id={p.id} className="space-y-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="flex flex-wrap items-center gap-2 font-semibold">
              <span className="truncate">{p.name}</span>
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted">{t(`iptv.admin.kind.${p.kind}` as MessageKey)}</span>
              {!p.enabled && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">{t("iptv.admin.disabled")}</span>}
              {p.via_proxy && <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent">proxy</span>}
            </h3>
            <p className="mt-0.5 truncate text-sm text-muted">{p.kind === "iptv_org_country" ? `iptv-org · ${p.country}` : p.kind === "m3u_url" ? p.url : p.has_content ? "M3U" : t("iptv.admin.no_file")}</p>
          </div>
          <label className="flex min-h-[44px] items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-5 w-5 accent-accent"
              checked={p.enabled}
              onChange={(e) => update.mutate({ id: p.id, body: { enabled: e.target.checked } })}
              data-testid="iptv-enabled"
            />
            {t("iptv.admin.enabled")}
          </label>
        </div>
        <Stats s={p.stats} />
        <div className="space-y-1.5">
          <StatusLine label={t("iptv.admin.playlist")} status={p.refresh.status} error={p.refresh.error} at={p.refresh.refreshed_at} extra={via} />
          <StatusLine
            label={t("iptv.admin.epg")}
            status={p.epg.status}
            error={p.epg.error}
            at={p.epg.refreshed_at}
            extra={p.epg.status === "none" ? undefined : t("iptv.admin.epg_stats", { programmes: p.epg.programmes, xmltv: p.epg.xmltv_channels })}
          />
          <GuideList guides={p.epg.guides ?? []} />
        </div>
        <ErrorText error={err ?? update.error ?? remove.error ?? upload.error} />
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={doRefresh} busy={refresh.isPending} disabled={running} data-testid="iptv-refresh">
            <RefreshIcon /> {t("iptv.admin.refresh")}
          </Button>
          {p.kind === "m3u_file" && (
            <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-xl bg-surface-2 px-4 font-semibold hover:bg-border">
              {upload.isPending && <Spinner size={16} />}
              {t("iptv.admin.upload")}
              <input
                type="file"
                accept=".m3u,.m3u8,audio/x-mpegurl,text/plain"
                className="sr-only"
                data-testid="iptv-upload"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) upload.mutate({ id: p.id, text: await f.text() });
                }}
              />
            </label>
          )}
          <Button variant="ghost" onClick={onEdit} data-testid="iptv-edit">
            {t("iptv.admin.edit")}
          </Button>
          <Button
            variant="danger"
            className="ml-auto"
            onClick={() => window.confirm(t("iptv.admin.delete_confirm", { name: p.name })) && remove.mutate(p.id)}
            data-testid="iptv-delete"
          >
            {t("common.delete")}
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- forms

interface Draft {
  name: string;
  url: string;
  epg_url: string;
  user_agent: string;
  referrer: string;
  via_proxy: boolean;
  enabled: boolean;
  position: number;
}

const blank: Draft = { name: "", url: "", epg_url: "", user_agent: "", referrer: "", via_proxy: false, enabled: true, position: 0 };
const orNull = (s: string) => (s.trim() ? s.trim() : null);

function CommonFields({ d, set, kind, errors, proxy }: { d: Draft; set: (p: Partial<Draft>) => void; kind: Kind; errors: Record<string, string>; proxy: boolean }) {
  const { t } = useI18n();
  return (
    <>
      {kind !== "iptv_org_country" && (
        <Field label={t("iptv.admin.name")} error={errors.name}>
          <Input value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={100} data-testid="iptv-name" />
        </Field>
      )}
      {kind === "m3u_url" && (
        <Field label={t("iptv.admin.url")} error={errors.url}>
          <Input type="url" value={d.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://…/playlist.m3u8" data-testid="iptv-url" />
        </Field>
      )}
      <Field label={t("iptv.admin.epg_url")} error={errors.epg_url}>
        <textarea
          value={d.epg_url}
          onChange={(e) => set({ epg_url: e.target.value })}
          placeholder="https://…/epg.xml.gz"
          rows={2}
          className="w-full min-h-[44px] rounded-xl border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
          data-testid="iptv-epg-url"
        />
      </Field>
      <p className="-mt-1 text-xs text-muted">{t("iptv.admin.epg_hint")}</p>
      <label className="flex items-start gap-3 py-1">
        <input type="checkbox" className="mt-0.5 h-5 w-5 accent-accent" checked={d.via_proxy} onChange={(e) => set({ via_proxy: e.target.checked })} data-testid="iptv-via-proxy" />
        <span>
          <span className="block font-medium">{t("iptv.admin.via_proxy")}</span>
          <span className="block text-xs text-muted">{proxy ? t("iptv.admin.via_proxy_hint") : t("iptv.admin.proxy_off")}</span>
        </span>
      </label>
      {kind !== "iptv_org_country" && (
        <details className="rounded-xl border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">{t("iptv.admin.advanced")}</summary>
          <div className="mt-2 space-y-3">
            <Field label={t("iptv.admin.user_agent")} error={errors.user_agent}>
              <Input value={d.user_agent} onChange={(e) => set({ user_agent: e.target.value })} maxLength={300} />
            </Field>
            <Field label={t("iptv.admin.referrer")} error={errors.referrer}>
              <Input value={d.referrer} onChange={(e) => set({ referrer: e.target.value })} />
            </Field>
          </div>
        </details>
      )}
    </>
  );
}

function AddSheet({ existing, proxy, onClose }: { existing: AdminPlaylist[]; proxy: boolean; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [kind, setKind] = useState<Kind>("iptv_org_country");
  const [d, setD] = useState<Draft>(blank);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const countries = useIptvCountries(true);
  const taken = new Set(existing.filter((p) => p.kind === "iptv_org_country").map((p) => p.country));
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const suggested = new Set((countries.data ?? []).filter((c) => c.suggested && !taken.has(c.code)).map((c) => c.code));
  const chosen = picked ?? suggested;
  const [file, setFile] = useState<File | null>(null);
  const { create, upload } = useAdminIptv();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const common = (): PlaylistInput => ({
    epg_url: orNull(d.epg_url),
    via_proxy: d.via_proxy,
    enabled: true,
    ...(kind !== "iptv_org_country" && { user_agent: orNull(d.user_agent), referrer: orNull(d.referrer) }),
  });
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (kind === "iptv_org_country") {
        for (const code of chosen) {
          const c = countries.data?.find((x) => x.code === code);
          await create.mutateAsync({ kind, country: code, name: (locale !== "en" ? c?.name_ru : c?.name_en) ?? code, ...common() });
        }
      } else if (kind === "m3u_url") {
        await create.mutateAsync({ kind, url: d.url.trim(), ...(d.name.trim() && { name: d.name.trim() }), ...common() });
      } else {
        const p = await create.mutateAsync({ kind, ...(d.name.trim() && { name: d.name.trim() }), ...common() });
        if (file) await upload.mutateAsync({ id: p.id, text: await file.text() });
      }
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const errors = fieldErrors(err);
  const toggle = (code: string) => {
    const n = new Set(chosen);
    if (n.has(code)) n.delete(code);
    else n.add(code);
    setPicked(n);
  };

  return (
    <Sheet title={t("iptv.admin.add")} onClose={onClose} wide testId="iptv-add-sheet">
      <div className="space-y-4">
        <div role="radiogroup" aria-label={t("iptv.admin.kind")} className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              data-testid={`iptv-kind-${k}`}
              onClick={() => setKind(k)}
              className={`min-h-[40px] rounded-lg px-2 text-sm font-medium ${kind === k ? "bg-surface text-text shadow" : "text-muted hover:text-text"}`}
            >
              {t(`iptv.admin.kind.${k}` as MessageKey)}
            </button>
          ))}
        </div>
        {kind === "iptv_org_country" && (
          <div>
            <p className="mb-1 text-sm font-medium">{t("iptv.admin.countries")}</p>
            <p className="mb-2 text-xs text-muted">{t("iptv.admin.countries_hint")}</p>
            {countries.isPending ? (
              <Spinner />
            ) : (
              <div className="flex flex-wrap gap-1.5" data-testid="iptv-countries">
                {(countries.data ?? []).map((c) => {
                  const already = taken.has(c.code);
                  const on = chosen.has(c.code);
                  return (
                    <button
                      key={c.code}
                      type="button"
                      disabled={already}
                      aria-pressed={on}
                      data-code={c.code}
                      data-testid="iptv-country"
                      onClick={() => toggle(c.code)}
                      className={`min-h-[36px] rounded-full border px-3 text-sm transition disabled:opacity-50 ${on ? "border-accent bg-accent text-on-accent" : "border-border hover:border-muted"}`}
                    >
                      {locale !== "en" ? c.name_ru : c.name_en}
                      {already && ` · ${t("iptv.admin.country_added")}`}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {kind === "m3u_file" && (
          <Field label={t("iptv.admin.file")}>
            <input
              type="file"
              accept=".m3u,.m3u8,audio/x-mpegurl,text/plain"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-surface-2 file:px-3 file:py-2 file:text-text"
              data-testid="iptv-file"
            />
          </Field>
        )}
        <CommonFields d={d} set={set} kind={kind} errors={errors} proxy={proxy} />
        <ErrorText error={err} />
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => void submit()}
            busy={busy}
            disabled={(kind === "iptv_org_country" && chosen.size === 0) || (kind === "m3u_url" && !d.url.trim()) || (kind === "m3u_file" && !file)}
            data-testid="iptv-create"
          >
            {t("iptv.admin.create")}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

function EditSheet({ p, proxy, onClose }: { p: AdminPlaylist; proxy: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { update } = useAdminIptv();
  const [d, setD] = useState<Draft>({
    name: p.name,
    url: p.url ?? "",
    epg_url: p.epg_url ?? "",
    user_agent: p.user_agent ?? "",
    referrer: p.referrer ?? "",
    via_proxy: p.via_proxy,
    enabled: p.enabled,
    position: p.position,
  });
  const set = (x: Partial<Draft>) => setD((o) => ({ ...o, ...x }));
  const save = () =>
    update.mutate(
      {
        id: p.id,
        body: {
          name: d.name.trim() || p.name,
          // GET masks credentials in the URL (***): send it only when the admin edited it.
          ...(p.kind === "m3u_url" && d.url.trim() !== (p.url ?? "") && { url: d.url.trim() }),
          epg_url: orNull(d.epg_url),
          via_proxy: d.via_proxy,
          enabled: d.enabled,
          position: d.position,
          ...(p.kind !== "iptv_org_country" && { user_agent: orNull(d.user_agent), referrer: orNull(d.referrer) }),
        },
      },
      { onSuccess: onClose },
    );
  return (
    <Sheet title={p.name} subtitle={t(`iptv.admin.kind.${p.kind}` as MessageKey)} onClose={onClose} wide testId="iptv-edit-sheet">
      <div className="space-y-4">
        {p.kind === "iptv_org_country" && (
          <Field label={t("iptv.admin.name")}>
            <Input value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={100} />
          </Field>
        )}
        <CommonFields d={d} set={set} kind={p.kind} errors={fieldErrors(update.error)} proxy={proxy} />
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="h-5 w-5 accent-accent" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
            {t("iptv.admin.enabled")}
          </label>
          <label className="flex items-center gap-2">
            {t("iptv.admin.position")}
            <Input type="number" min={0} max={1000} value={d.position} onChange={(e) => set({ position: Number(e.target.value) || 0 })} className="!w-24" />
          </label>
        </div>
        <ErrorText error={update.error} />
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save} busy={update.isPending} data-testid="iptv-save">
            {t("common.save")}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

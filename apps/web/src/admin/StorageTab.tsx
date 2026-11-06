// Admin → «Хранилище»: disk usage, storage settings, every server download
// (sort, multi-select delete, pin) and the torrents in the shared TorrServer.
import { useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@martytv/contracts";
import { episodeCode } from "@martytv/media-types";
import { Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { Button, Card, ErrorText, Field, fieldErrors, Input, timeAgo } from "../components";
import { formatBytes, formatRate } from "./format";
import { diskSegments, inactiveTorrents, sizeLine, sortDownloads, type Download, type SortKey, type StorageStatus, type TorrServerTorrent } from "../downloads/format";
import {
  removeTorrent,
  torrentsKey,
  useAllDownloads,
  useDeleteDownload,
  usePatchDownload,
  useStorage,
  useTorrServerTorrents,
  useUpdateStorage,
} from "../downloads/queries";
import { ConfirmSheet, DownloadProgress, PinIcon, ServerDownloadIcon, StatusChip, TrashIcon, useNow } from "../downloads/ui";
import { RefreshIcon } from "../icons";

export function StorageTab() {
  const storage = useStorage();
  return (
    <div className="space-y-4" data-testid="storage-tab">
      <ErrorText error={storage.error} />
      {storage.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : storage.data ? (
        <>
          <DiskCard s={storage.data} />
          <SettingsCard key={JSON.stringify(storage.data.settings)} s={storage.data} />
        </>
      ) : null}
      <AllDownloads />
      <TorrentsCard />
    </div>
  );
}

// ---------------------------------------------------------------- disk

const SEGMENTS: { key: "other" | "library" | "reserve" | "free"; label: MessageKey; cls: string }[] = [
  { key: "other", label: "downloads.admin.seg_other", cls: "bg-muted/60" },
  { key: "library", label: "downloads.admin.seg_library", cls: "bg-accent" },
  { key: "reserve", label: "downloads.admin.seg_reserve", cls: "bg-warn/70" },
  { key: "free", label: "downloads.admin.seg_free", cls: "bg-ok/30" },
];

function DiskCard({ s }: { s: StorageStatus }) {
  const { t, locale } = useI18n();
  const seg = diskSegments(s);
  const pct = (v: number) => (seg.total > 0 ? (v / seg.total) * 100 : 0);
  const c = s.counts;
  return (
    <Card className="space-y-3" >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="font-semibold">{t("downloads.admin.disk")}</h2>
        <p className="text-sm tabular-nums text-muted">
          {t("downloads.admin.disk_summary", { free: formatBytes(s.disk_free_bytes, locale), total: formatBytes(s.disk_total_bytes, locale) })}
        </p>
      </div>
      {!s.ok && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger" data-testid="storage-not-ok">{t("downloads.admin.not_ok")}</p>}
      <div className="flex h-4 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={SEGMENTS.map((x) => `${t(x.label)} ${formatBytes(seg[x.key], locale)}`).join(", ")} data-testid="disk-bar">
        {SEGMENTS.map((x) => (seg[x.key] > 0 ? <div key={x.key} className={x.cls} style={{ width: `${pct(seg[x.key])}%` }} /> : null))}
      </div>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
        {SEGMENTS.map((x) => (
          <li key={x.key} className="flex min-w-0 items-center gap-1.5">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${x.cls}`} />
            <span className="truncate text-muted">{t(x.label)}</span>
            <span className="ml-auto font-semibold tabular-nums sm:ml-0">{formatBytes(seg[x.key], locale)}</span>
          </li>
        ))}
      </ul>
      <p className="text-sm font-medium">{t("downloads.admin.available", { size: formatBytes(s.available_bytes, locale) })}</p>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
        <span>{t("downloads.status.downloading")}: {c.downloading}</span>
        <span>{t("downloads.status.queued")}: {c.queued}</span>
        <span>{t("downloads.status.waiting_space")}: {c.waiting_space}</span>
        <span>{t("downloads.status.paused")}: {c.paused}</span>
        <span>{t("downloads.status.done")}: {c.done}</span>
        <span>{t("downloads.status.failed")}: {c.failed}</span>
        <span>{t("downloads.admin.jobs", { n: s.max_jobs })}</span>
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------- settings

function SettingsCard({ s }: { s: StorageStatus }) {
  const { t } = useI18n();
  const update = useUpdateStorage();
  const [reserve, setReserve] = useState(String(s.settings.reserve_gb));
  const [cap, setCap] = useState(s.settings.max_library_gb == null ? "" : String(s.settings.max_library_gb));
  const [days, setDays] = useState(String(s.settings.keep_days));
  const [saved, setSaved] = useState(false);
  const errs = fieldErrors(update.error);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    update.mutate(
      { reserve_gb: Number(reserve), max_library_gb: cap.trim() === "" ? null : Number(cap), keep_days: Math.round(Number(days)) },
      { onSuccess: () => setSaved(true) },
    );
  };
  return (
    <Card>
      <form onSubmit={submit} className="space-y-3" data-testid="storage-settings">
        <h2 className="font-semibold">{t("downloads.admin.settings")}</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Field label={t("downloads.admin.reserve_gb")} error={errs.reserve_gb}>
              <Input type="number" inputMode="decimal" min={1} step="any" required value={reserve} onChange={(e) => setReserve(e.target.value)} name="reserve_gb" />
            </Field>
            <p className="text-xs text-muted">{t("downloads.admin.reserve_hint")}</p>
          </div>
          <div className="space-y-1">
            <Field label={t("downloads.admin.max_library_gb")} error={errs.max_library_gb}>
              <Input type="number" inputMode="decimal" min={1} step="any" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="∞" name="max_library_gb" />
            </Field>
            <p className="text-xs text-muted">{t("downloads.admin.max_library_hint")}</p>
          </div>
          <div className="space-y-1">
            <Field label={t("downloads.admin.keep_days")} error={errs.keep_days}>
              <Input type="number" inputMode="numeric" min={1} max={3650} step={1} required value={days} onChange={(e) => setDays(e.target.value)} name="keep_days" />
            </Field>
            <p className="text-xs text-muted">{t("downloads.admin.keep_days_hint")}</p>
          </div>
        </div>
        {update.error && !Object.keys(errs).length ? <ErrorText error={update.error} /> : null}
        <div className="flex items-center gap-3">
          <Button type="submit" busy={update.isPending} className="w-full sm:w-auto">
            {t("downloads.admin.save")}
          </Button>
          {saved && <span className="text-sm text-ok" data-testid="storage-saved">{t("downloads.admin.saved")}</span>}
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------- all downloads

function AllDownloads() {
  const { t, locale } = useI18n();
  const q = useAllDownloads();
  const [sort, setSort] = useState<SortKey>("newest");
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [confirm, setConfirm] = useState<Download[] | null>(null);
  const [busy, setBusy] = useState(false);
  const del = useDeleteDownload();
  const items = sortDownloads(q.data ?? [], sort);
  const selected = items.filter((d) => picked.has(d.id));
  const selectedSize = selected.reduce((n, d) => n + d.size, 0);
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allOn = items.length > 0 && selected.length === items.length;

  const runDelete = async (list: Download[]) => {
    setBusy(true);
    for (const d of list) await del.mutateAsync(d.id).catch(() => undefined);
    setBusy(false);
    setPicked((p) => new Set([...p].filter((id) => !list.some((d) => d.id === id))));
    setConfirm(null);
  };

  return (
    <Card className="space-y-3" >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-semibold">{t("downloads.admin.all")}</h2>
        <div role="radiogroup" aria-label={t("downloads.admin.sort")} className="inline-flex rounded-full border border-border bg-bg/40 p-0.5" data-testid="downloads-sort">
          {(["newest", "size", "age"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={sort === k}
              data-sort={k}
              onClick={() => setSort(k)}
              className={`min-h-[34px] rounded-full px-3 text-xs font-semibold ${sort === k ? "bg-accent text-on-accent" : "text-text/80 hover:text-text"}`}
            >
              {t(k === "newest" ? "downloads.admin.sort_newest" : k === "size" ? "downloads.admin.sort_size" : "downloads.admin.sort_age")}
            </button>
          ))}
        </div>
      </div>
      <ErrorText error={q.error} />
      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 px-3 py-1.5 text-sm">
          <label className="flex min-h-[40px] items-center gap-2">
            <input
              type="checkbox"
              className="h-5 w-5 accent-[rgb(var(--mt-accent))]"
              checked={allOn}
              onChange={() => setPicked(allOn ? new Set() : new Set(items.map((d) => d.id)))}
              data-testid="downloads-select-all"
            />
            {t("downloads.admin.select_all")}
          </label>
          {selected.length > 0 && (
            <>
              <span className="text-muted tabular-nums" data-testid="downloads-selected">
                {t("downloads.admin.selected", { n: selected.length, size: formatBytes(selectedSize, locale) })}
              </span>
              <button
                type="button"
                onClick={() => setConfirm(selected)}
                className="ml-auto inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-danger/15 px-3 font-semibold text-danger hover:bg-danger/25"
                data-testid="downloads-delete-selected"
              >
                <TrashIcon />
                {t("downloads.admin.delete_selected")}
              </button>
            </>
          )}
        </div>
      )}
      {q.isPending ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">{t("downloads.admin.none")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border" data-testid="admin-downloads">
          {items.map((d) => (
            <AdminDownloadRow key={d.id} d={d} picked={picked.has(d.id)} onPick={() => toggle(d.id)} onDelete={() => setConfirm([d])} />
          ))}
        </ul>
      )}
      {confirm && (
        <ConfirmSheet
          title={confirm.length === 1 ? t("downloads.delete_title") : t("downloads.admin.delete_many_title", { n: confirm.length })}
          confirm={t("downloads.delete")}
          busy={busy}
          testId="admin-delete-confirm"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void runDelete(confirm)}
        >
          <p>
            {confirm.length === 1
              ? t("downloads.delete_body_admin", { title: titleOf(confirm[0]!) })
              : t("downloads.admin.delete_many_body", { size: formatBytes(confirm.reduce((n, d) => n + d.size, 0), locale) })}
          </p>
          <ErrorText error={del.error} />
        </ConfirmSheet>
      )}
    </Card>
  );
}

function titleOf(d: Download): string {
  const name = d.media?.title ?? d.release_title;
  return d.season != null && d.episode != null ? `${name} · ${episodeCode(d.season, d.episode)}` : name;
}

function AdminDownloadRow({ d, picked, onPick, onDelete }: { d: Download; picked: boolean; onPick: () => void; onDelete: () => void }) {
  const { t, locale } = useI18n();
  const now = useNow();
  const patch = usePatchDownload();
  const users = (d.users ?? []).map((u) => u.display_name || u.username).join(", ");
  return (
    <li className={`flex gap-3 p-3 ${picked ? "bg-accent/[0.06]" : ""}`} data-testid="admin-download-row" data-download-id={d.id}>
      <input
        type="checkbox"
        className="mt-1 h-5 w-5 shrink-0 accent-[rgb(var(--mt-accent))]"
        checked={picked}
        onChange={onPick}
        aria-label={titleOf(d)}
        data-testid="admin-download-pick"
      />
      <div className="min-w-0 flex-1 space-y-1.5 md:grid md:grid-cols-[minmax(0,1fr)_14rem] md:gap-x-4 md:space-y-0">
        <div className="min-w-0 space-y-1">
          <p className="line-clamp-2 text-sm font-semibold leading-snug">{titleOf(d)}</p>
          <p className="line-clamp-1 break-all text-[11px] text-muted" title={d.file_name}>{d.file_name}</p>
          {users && <p className="text-xs text-muted">{t("downloads.requested_by", { names: users })}</p>}
        </div>
        <div className="min-w-0 space-y-1.5">
          <StatusChip d={d} short />
          {d.status !== "done" && <DownloadProgress d={d} />}
          <p className="text-xs tabular-nums text-muted">{sizeLine(d, t, locale, now)}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <button
          type="button"
          aria-pressed={d.pinned}
          aria-label={t("downloads.pin")}
          title={t("downloads.pin")}
          disabled={patch.isPending}
          onClick={() => patch.mutate({ id: d.id, pinned: !d.pinned })}
          className={`flex h-10 w-10 items-center justify-center rounded-full text-lg hover:bg-surface-2 ${d.pinned ? "text-accent" : "text-muted"}`}
          data-testid="admin-download-pin"
        >
          <PinIcon filled={d.pinned} />
        </button>
        <button
          type="button"
          aria-label={t("downloads.delete")}
          title={t("downloads.delete")}
          onClick={onDelete}
          className="flex h-10 w-10 items-center justify-center rounded-full text-lg text-danger hover:bg-danger/10"
          data-testid="admin-download-delete"
        >
          <TrashIcon />
        </button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- TorrServer

type Removal = { list: TorrServerTorrent[]; inUse?: TorrServerTorrent };

function TorrentsCard() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const q = useTorrServerTorrents();
  const items = q.data ?? [];
  const inactive = inactiveTorrents(items);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ removed: number; failed: number } | null>(null);
  const [error, setError] = useState<unknown>(null);

  const run = async (r: Removal, force: boolean) => {
    setBusy(true);
    setError(null);
    let removed = 0;
    let failed = 0;
    let inUse: TorrServerTorrent | undefined;
    for (const x of r.list) {
      try {
        await removeTorrent(x.hash, force);
        removed++;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.code === "torrent_in_use" && r.list.length === 1) inUse = x;
        else {
          failed++;
          setError(e);
        }
      }
    }
    setBusy(false);
    void qc.invalidateQueries({ queryKey: torrentsKey });
    if (inUse) return setRemoval({ list: [inUse], inUse });
    setRemoval(null);
    if (r.list.length > 1) setResult({ removed, failed });
  };

  return (
    <Card className="space-y-3" >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-semibold">{t("downloads.admin.torrents")}</h2>
        <button
          type="button"
          onClick={() => void q.refetch()}
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold text-accent hover:bg-surface-2"
        >
          <RefreshIcon className={q.isFetching ? "animate-spin" : ""} />
          {t("downloads.admin.refresh")}
        </button>
        {inactive.length > 0 && (
          <button
            type="button"
            onClick={() => setRemoval({ list: inactive })}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-danger/15 px-3 text-sm font-semibold text-danger hover:bg-danger/25"
            data-testid="torrents-remove-inactive"
          >
            <TrashIcon />
            {t("downloads.admin.remove_inactive", { n: inactive.length })}
          </button>
        )}
      </div>
      <p className="text-xs leading-relaxed text-muted">{t("downloads.admin.torrents_hint")}</p>
      <ErrorText error={q.error ?? error} />
      {result && (
        <p className="rounded-xl bg-surface-2 px-3 py-2 text-sm" role="status" data-testid="torrents-result">
          {t("downloads.admin.removed_n", { n: result.removed })}
          {result.failed > 0 && <span className="text-danger"> · {t("downloads.admin.failed_n", { n: result.failed })}</span>}
        </p>
      )}
      {q.isPending ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">{t("downloads.admin.no_torrents")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border" data-testid="torrents">
          {items.map((x) => (
            <li key={x.hash} className="flex gap-3 p-3" data-testid="torrent-row" data-hash={x.hash}>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="line-clamp-2 break-words text-sm font-semibold leading-snug [overflow-wrap:anywhere]">{x.title || x.hash}</p>
                <p className="text-xs tabular-nums text-muted">
                  {[
                    formatBytes(x.size_bytes, locale),
                    x.stat_string,
                    x.added_at ? t("downloads.admin.added", { when: timeAgo(x.added_at, locale) }) : null,
                    x.idle ? null : t("downloads.admin.peers", { n: x.peers }),
                    x.idle ? null : formatRate(x.download_speed_bps, locale),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <p className="flex flex-wrap gap-1">
                  {x.martytv.sources > 0 && <Tag>{t("downloads.admin.sources", { n: x.martytv.sources })}</Tag>}
                  {x.martytv.download && (
                    <Tag tone="accent">
                      <ServerDownloadIcon className="mr-1" />
                      {statusLabel(x.martytv.download.status, t)}
                    </Tag>
                  )}
                  {x.martytv.streaming && <Tag tone="ok">{t("downloads.admin.streaming")}</Tag>}
                  {x.idle && !x.martytv.in_use && <Tag>{t("downloads.admin.idle")}</Tag>}
                </p>
              </div>
              <button
                type="button"
                aria-label={`${t("downloads.admin.remove")}: ${x.title}`}
                title={t("downloads.admin.remove")}
                onClick={() => setRemoval({ list: [x] })}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg text-danger hover:bg-danger/10"
                data-testid="torrent-remove"
              >
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
      {removal && (
        <ConfirmSheet
          title={
            removal.inUse
              ? t("downloads.admin.in_use_title")
              : removal.list.length === 1
                ? t("downloads.admin.remove_title")
                : t("downloads.admin.remove_many_title", { n: removal.list.length })
          }
          confirm={removal.inUse ? t("downloads.admin.force") : t("downloads.admin.remove")}
          busy={busy}
          testId={removal.inUse ? "torrent-in-use" : "torrent-remove-confirm"}
          onCancel={() => setRemoval(null)}
          onConfirm={() => void run(removal, !!removal.inUse)}
        >
          {removal.inUse ? (
            <>
              <p>{t("downloads.admin.in_use_body", { title: removal.inUse.title })}</p>
              <p>{t("downloads.admin.remove_body", { title: removal.inUse.title })}</p>
            </>
          ) : removal.list.length === 1 ? (
            <p>{t("downloads.admin.remove_body", { title: removal.list[0]!.title })}</p>
          ) : (
            <p>{t("downloads.admin.remove_many_body")}</p>
          )}
        </ConfirmSheet>
      )}
    </Card>
  );
}

function statusLabel(s: Download["status"], t: ReturnType<typeof useI18n>["t"]): string {
  return t(`downloads.status.${s}` as MessageKey);
}

function Tag({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "accent" | "ok" }) {
  const cls = { plain: "border-border bg-surface-2 text-text/80", accent: "border-accent/40 bg-accent/10 text-accent", ok: "border-ok/40 bg-ok/10 text-ok" }[tone];
  return <span className={`inline-flex min-h-[22px] items-center rounded-md border px-1.5 text-[11px] font-semibold ${cls}`}>{children}</span>;
}

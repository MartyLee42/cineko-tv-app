// «Загрузки»: what is saved on this device (offline/ui.tsx), then the caller's
// server downloads with progress, pin, pause/resume and delete.
import { useState } from "react";
import { Link } from "react-router";
import { isAdminRole } from "@martytv/contracts";
import { episodeCode } from "@martytv/media-types";
import { Spinner, useI18n } from "@martytv/ui";
import { Card, ErrorText, PageTitle } from "../components";
import { Poster } from "../catalog/components";
import { useSession } from "../session";
import { formatBytes } from "../admin/format";
import { errorKey, isActive, keepDaysFrom, sizeLine, type Download } from "../downloads/format";
import { useDeleteDownload, useDownloads, usePatchDownload } from "../downloads/queries";
import { ConfirmSheet, DownloadProgress, PinIcon, ServerDownloadIcon, StatusChip, TrashIcon, useNow } from "../downloads/ui";
import { PauseIcon, PlayIcon } from "../icons";
import { DeviceCard } from "../offline/ui";

export function DownloadsPage() {
  const { t } = useI18n();
  const { data: session } = useSession();
  const q = useDownloads();
  const items = q.data ?? [];
  const active = items.filter((d) => isActive(d.status) || d.status === "failed");
  const done = items.filter((d) => d.status === "done");
  const [deleting, setDeleting] = useState<Download | null>(null);
  const del = useDeleteDownload();

  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="downloads-page">
      <PageTitle>{t("downloads.title")}</PageTitle>
      <DeviceCard />
      <p className="px-1 text-xs leading-relaxed text-muted" data-testid="downloads-explain">
        {t("devicedl.explain")}
      </p>
      <Card className="flex gap-3 text-sm leading-relaxed text-muted">
        <ServerDownloadIcon className="mt-0.5 shrink-0 text-lg text-accent" />
        <div className="min-w-0 space-y-1">
          <p className="font-semibold text-text">{t("downloads.rules_title")}</p>
          <p data-testid="downloads-rules">{t("downloads.rules", { days: keepDaysFrom(items) })}</p>
          {isAdminRole(session?.user.role) && (
            <Link to="/admin?tab=storage" className="inline-flex min-h-[36px] items-center font-semibold text-accent">
              {t("downloads.storage_link")}
            </Link>
          )}
        </div>
      </Card>
      <ErrorText error={q.error} />
      {q.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : items.length === 0 && !q.error ? (
        <div className="rounded-2xl border border-dashed border-border px-4 py-10 text-center" data-testid="downloads-empty">
          <p className="font-semibold">{t("downloads.empty")}</p>
          <p className="mt-1 text-sm text-muted">{t("downloads.empty_hint")}</p>
        </div>
      ) : (
        <>
          {active.length > 0 && <Section title={t("downloads.section.active")} items={active} onDelete={setDeleting} />}
          {done.length > 0 && <Section title={t("downloads.section.done")} items={done} onDelete={setDeleting} />}
        </>
      )}
      {deleting && (
        <ConfirmSheet
          title={t("downloads.delete_title")}
          confirm={t("downloads.delete")}
          busy={del.isPending}
          testId="download-delete-confirm"
          onCancel={() => setDeleting(null)}
          onConfirm={() => del.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
        >
          <p>{t("downloads.delete_body", { title: titleOf(deleting) })}</p>
          <ErrorText error={del.error} />
        </ConfirmSheet>
      )}
    </div>
  );
}

function titleOf(d: Download): string {
  const name = d.media?.title ?? d.release_title;
  return d.season != null && d.episode != null ? `${name} · ${episodeCode(d.season, d.episode)}` : name;
}

function Section({ title, items, onDelete }: { title: string; items: Download[]; onDelete: (d: Download) => void }) {
  return (
    <section className="space-y-2.5">
      <h2 className="px-1 text-sm font-semibold uppercase tracking-wider text-muted">{title}</h2>
      <ul className="space-y-2.5">
        {items.map((d) => (
          <li key={d.id}>
            <DownloadRow d={d} onDelete={() => onDelete(d)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function DownloadRow({ d, onDelete }: { d: Download; onDelete: () => void }) {
  const { t, locale } = useI18n();
  const now = useNow();
  const patch = usePatchDownload();
  const err = errorKey(d);
  const canPause = d.status === "queued" || d.status === "downloading" || d.status === "waiting_space";
  const btn = "inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition hover:bg-surface-2 disabled:opacity-50";
  const media = d.media;
  return (
    <article className="overflow-hidden rounded-2xl border border-border bg-surface" data-testid="download-row" data-download-id={d.id} data-status={d.status}>
      <div className="flex gap-3 p-3">
        {media ? (
          <Link to={`/title/${media.id}`} className="w-14 shrink-0 sm:w-16" aria-hidden tabIndex={-1}>
            <Poster item={media} sizes="64px" />
          </Link>
        ) : (
          <div className="flex aspect-[2/3] w-14 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-xl text-muted sm:w-16">
            <ServerDownloadIcon />
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-1.5">
          <div>
            {media ? (
              <Link to={`/title/${media.id}`} className="line-clamp-2 font-semibold leading-snug hover:text-accent">
                {media.title}
              </Link>
            ) : (
              <p className="line-clamp-2 font-semibold leading-snug">{d.release_title}</p>
            )}
            {d.season != null && d.episode != null && (
              <p className="font-mono text-xs font-semibold text-accent">{episodeCode(d.season, d.episode)}</p>
            )}
            <p className="mt-0.5 line-clamp-2 break-all text-[11px] leading-snug text-muted" title={d.file_name}>
              {d.file_name}
            </p>
          </div>
          <StatusChip d={d} short />
          {d.status !== "done" && <DownloadProgress d={d} />}
          <p className="text-xs tabular-nums text-muted" data-testid="download-size">{sizeLine(d, t, locale, now)}</p>
          {err && <p className="text-xs text-danger">{t(err)}</p>}
          {d.status === "waiting_space" && d.space_needed_bytes != null && (
            <p className="text-xs text-muted">{t("downloads.needs_space", { size: formatBytes(d.space_needed_bytes, locale) })}</p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t border-border/70 px-1.5 py-1">
        <button
          type="button"
          aria-pressed={d.pinned}
          disabled={patch.isPending}
          onClick={() => patch.mutate({ id: d.id, pinned: !d.pinned })}
          className={`${btn} ${d.pinned ? "text-accent" : "text-text/80"}`}
          data-testid="download-pin"
        >
          <PinIcon filled={d.pinned} className="text-sm" />
          {d.pinned ? t("downloads.unpin") : t("downloads.pin")}
        </button>
        {(canPause || d.status === "paused" || d.status === "failed") && (
          <button
            type="button"
            disabled={patch.isPending}
            // paused:false also restarts a failed download (PATCH /downloads/{id}).
            onClick={() => patch.mutate({ id: d.id, paused: d.status !== "paused" && d.status !== "failed" })}
            className={`${btn} text-text/80`}
            data-testid="download-pause"
          >
            {d.status === "paused" || d.status === "failed" ? <PlayIcon className="text-sm" /> : <PauseIcon className="text-sm" />}
            {d.status === "paused" || d.status === "failed" ? t("downloads.resume") : t("downloads.pause")}
          </button>
        )}
        <button type="button" onClick={onDelete} className={`${btn} ml-auto text-danger hover:bg-danger/10`} data-testid="download-delete">
          <TrashIcon className="text-sm" />
          {t("downloads.delete")}
        </button>
      </div>
      {patch.error ? (
        <div className="px-3 pb-2">
          <ErrorText error={patch.error} />
        </div>
      ) : null}
    </article>
  );
}

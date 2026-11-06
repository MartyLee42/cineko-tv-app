// Small shared pieces for server downloads: icons, status chip, progress, confirm dialog.
import { useEffect, useState, type ReactNode, type SVGProps } from "react";
import { Link } from "react-router";
import { CvIcon, useConstructivism, useI18n, type CvGlyph } from "@martytv/ui";
import { Sheet } from "../remote/SendToTv";
import { chipInfo, downloadsFor, primaryDownload, progressPercent, type ChipTone, type DownloadBrief } from "./format";
import { useDownloads } from "./queries";

type P = SVGProps<SVGSVGElement>;

function Svg({ children, cv, ...rest }: P & { cv?: CvGlyph }) {
  // «Конструктивизм»: its filled pictograms.
  const on = useConstructivism();
  if (on && cv) return <CvIcon glyph={cv} {...rest} />;
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      {children}
    </svg>
  );
}

/** Server with a down arrow: «Скачать на сервер» / «Загрузки». */
export const ServerDownloadIcon = (p: P) => (
  <Svg {...p} cv="download">
    <rect x="3" y="14" width="18" height="7" rx="2" />
    <path d="M7 17.5h.01" />
    <path d="M12 3v8M8.5 7.5 12 11l3.5-3.5" />
  </Svg>
);

export const PinIcon = ({ filled, ...p }: P & { filled?: boolean }) => (
  <Svg {...p} cv={filled ? "bookmark" : "bookmarkOutline"}>
    <path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z" fill={filled ? "currentColor" : "none"} />
    <path d="M12 15v6" />
  </Svg>
);

export const TrashIcon = (p: P) => (
  <Svg {...p} cv="close">
    <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" />
    <path d="M10 11v5.5M14 11v5.5" />
  </Svg>
);

/** "now" that ticks once a minute (keep-until dates; avoids Date.now() in render). */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const TONE: Record<ChipTone, string> = {
  progress: "border-accent/40 bg-accent/10 text-accent",
  wait: "border-border bg-surface-2 text-text/85",
  error: "border-danger/40 bg-danger/10 text-danger",
  done: "border-ok/40 bg-ok/10 text-ok",
};

/** «Загружается 42% · 1,2 МБ/с · ~35 мин» / «На сервере ✓ · хранится до 28.11». */
export function StatusChip({ d, className = "", to, short }: { d: DownloadBrief; className?: string; to?: string; short?: boolean }) {
  const { t, locale } = useI18n();
  const now = useNow();
  const { tone, text } = chipInfo(d, t, locale, now, short);
  const pct = progressPercent(d);
  const cls = `relative inline-flex min-h-[32px] max-w-full items-center gap-1.5 overflow-hidden rounded-full border px-3 text-xs font-semibold ${TONE[tone]} ${className}`;
  const body = (
    <>
      {tone === "progress" && <span aria-hidden className="absolute inset-y-0 left-0 bg-accent/15" style={{ width: `${pct}%` }} />}
      <ServerDownloadIcon className="relative shrink-0 text-sm" />
      <span className="relative min-w-0 truncate tabular-nums">{text}</span>
    </>
  );
  return to ? (
    <Link to={to} className={`${cls} hover:brightness-110`} data-testid="download-chip" data-status={d.status}>
      {body}
    </Link>
  ) : (
    <span className={cls} data-testid="download-chip" data-status={d.status}>
      {body}
    </span>
  );
}

/** Title page: the caller's download of this movie / episode, live (nothing when there's none). */
export function DownloadChip({
  mediaId,
  episode,
  className = "",
}: {
  mediaId: string;
  episode?: { episode_id: string; season_number: number; episode_number: number };
  className?: string;
}) {
  const q = useDownloads({ media_id: mediaId });
  const d = primaryDownload(downloadsFor(q.data ?? [], episode ?? {}));
  if (!d) return null;
  return <StatusChip d={d} to="/downloads" className={className} />;
}

export function DownloadProgress({ d, className = "" }: { d: DownloadBrief; className?: string }) {
  const { t } = useI18n();
  const pct = progressPercent(d);
  const tone = d.status === "failed" ? "bg-danger" : d.status === "downloading" ? "bg-accent" : d.status === "done" ? "bg-ok" : "bg-muted";
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={t("downloads.status.downloading_short", { percent: pct })}
      className={`h-1.5 overflow-hidden rounded-full bg-text/15 ${className}`}
    >
      <div className={`h-full rounded-full transition-[width] ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** A confirm dialog (bottom sheet on phones). */
export function ConfirmSheet({
  title,
  children,
  confirm,
  onConfirm,
  onCancel,
  busy,
  danger = true,
  testId,
}: {
  title: string;
  children: ReactNode;
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  danger?: boolean;
  testId?: string;
}) {
  const { t } = useI18n();
  return (
    <Sheet title={title} onClose={onCancel} role="alertdialog" testId={testId}>
      <div className="space-y-5">
        <div className="space-y-2 text-sm leading-relaxed text-text/85">{children}</div>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" data-autofocus onClick={onCancel} className="min-h-[48px] rounded-xl bg-surface-2 font-semibold hover:bg-border">
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            data-testid="confirm-yes"
            className={`min-h-[48px] rounded-xl px-2 font-semibold disabled:opacity-60 ${danger ? "bg-danger text-white hover:bg-danger/85" : "bg-accent text-on-accent hover:bg-accent-strong"}`}
          >
            {confirm}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

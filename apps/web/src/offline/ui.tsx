// Offline UI: the «На устройстве» list, the screen shown when the server is
// unreachable, the offline player, and the player-menu section.
import { useEffect, useRef } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { PlaybackSource } from "@martytv/contracts";
import { Logo, useI18n } from "@martytv/ui";
import { Button, Card } from "../components";
import { formatBytes } from "../admin/format";
import { TrashIcon } from "../downloads/ui";
import { PlayIcon } from "../icons";
import {
  cancelDownload, deviceId, deviceItem, deviceJob, deviceSupported, downloadToDevice, offlineVideoUrl, removeFromDevice, saveOfflinePosition,
  useDevice, type DeviceItem,
} from "./device";

const PhoneIcon = ({ className = "" }: { className?: string }) => (
  <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
    <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
    <path d="M12 8v6M9.5 11.5 12 14l2.5-2.5" />
  </svg>
);

const NoteIcon = ({ className = "" }: { className?: string }) => (
  <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M9 17.5V6.2a1 1 0 0 1 .76-.97l9-2.25A1 1 0 0 1 20 3.95v11.3a3 3 0 1 1-2-2.83V7.03l-7 1.75v8.72A3 3 0 1 1 9 17.5z" />
  </svg>
);

/** Saved items + running downloads, each playable offline. */
export function DeviceList({ empty = true }: { empty?: boolean }) {
  const { t, locale } = useI18n();
  const { items, jobs, totalBytes } = useDevice();
  if (!items.length && !jobs.length) return empty ? <p className="text-sm text-muted">{t("offline.device.empty")}</p> : null;
  return (
    <div className="space-y-2" data-testid="device-downloads">
      {jobs.map((j) => {
        const pct = j.total ? Math.min(100, Math.round((j.bytes / j.total) * 100)) : null;
        return (
          <div key={j.id} className="flex items-center gap-3 rounded-xl border border-border p-3 text-sm">
            <PhoneIcon className="shrink-0 text-lg text-accent" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{j.error ? t(j.error === "quota" ? "offline.device.quota" : "offline.device.failed") : t("offline.device.downloading")}</p>
              <p className="text-xs text-muted">
                {formatBytes(j.bytes, locale)}
                {j.total ? ` / ${formatBytes(j.total, locale)}` : ""}
                {pct != null ? ` · ${pct}%` : ""}
              </p>
              {pct != null && (
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                </div>
              )}
            </div>
            {!j.error && (
              <button type="button" className="min-h-[40px] px-2 text-xs font-semibold text-muted hover:text-text" onClick={() => cancelDownload(j.id)}>
                {t("common.cancel")}
              </button>
            )}
          </div>
        );
      })}
      {items.map((it) => (
        <DeviceRow key={it.id} it={it} />
      ))}
      <p className="pt-1 text-xs text-muted">{t("offline.device.total", { size: formatBytes(totalBytes, locale) })}</p>
    </div>
  );
}

function DeviceRow({ it }: { it: DeviceItem }) {
  const { t, locale } = useI18n();
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border p-2 pr-3 text-sm">
      <Link to={`/offline/${encodeURIComponent(it.id)}`} className="flex min-w-0 flex-1 items-center gap-3">
        <div className="h-16 w-11 shrink-0 overflow-hidden rounded-md bg-surface-2">
          {it.poster && <img src={it.poster} alt="" className="h-full w-full object-cover" loading="lazy" />}
        </div>
        <div className="min-w-0">
          <p className="truncate font-semibold">{it.title}</p>
          {it.subtitle && <p className="truncate text-xs text-muted">{it.subtitle}</p>}
          <p className="text-xs text-muted">{formatBytes(it.size, locale)}</p>
        </div>
      </Link>
      <Link to={`/offline/${encodeURIComponent(it.id)}`} aria-label={t("offline.device.play")} className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-on-accent">
        <PlayIcon />
      </Link>
      <button
        type="button"
        aria-label={t("offline.device.delete")}
        className="flex h-10 w-10 items-center justify-center rounded-full text-muted hover:text-danger"
        onClick={() => void removeFromDevice(it.id)}
      >
        <TrashIcon />
      </button>
    </div>
  );
}

/** Shown instead of the app when the server can't be reached. */
export function OfflineScreen({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="mx-auto flex min-h-full max-w-xl flex-col gap-4 px-4 pb-10 pt-[max(1.5rem,env(safe-area-inset-top))]" data-testid="offline-screen">
      <div className="text-2xl">
        <Logo />
      </div>
      <Card className="space-y-2">
        <p className="text-lg font-bold">{t("offline.title")}</p>
        <p className="text-sm text-muted">{t("offline.body")}</p>
        <Button variant="secondary" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      </Card>
      {/* Full page load: /music is a separate app with its own offline cache. */}
      <a href="/music/" className="flex items-center gap-3 rounded-2xl bg-accent p-4 font-bold text-on-accent" data-testid="offline-music">
        <NoteIcon className="text-2xl" />
        <span className="flex-1">{t("offline.music")}</span>
        <span aria-hidden="true">→</span>
      </a>
      <Card className="space-y-3">
        <p className="font-bold">{t("offline.device.title")}</p>
        <DeviceList />
      </Card>
    </div>
  );
}

/** /offline/:id — plays a saved film or episode from this device. */
export function OfflinePlayerPage() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const it = deviceItem(id);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = video.current;
    if (!v || !it) return;
    const start = it.position && (!it.duration || it.position < it.duration - 60) ? it.position : 0;
    const onMeta = () => {
      if (start > 5) v.currentTime = start;
    };
    let last = 0;
    const onTime = () => {
      if (Math.abs(v.currentTime - last) > 5) {
        last = v.currentTime;
        saveOfflinePosition(id, v.currentTime);
      }
    };
    v.addEventListener("loadedmetadata", onMeta, { once: true });
    v.addEventListener("timeupdate", onTime);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      saveOfflinePosition(id, v.currentTime);
    };
  }, [id, it]);
  if (!it) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p>{t("offline.device.missing")}</p>
        <Button variant="secondary" onClick={() => navigate(-1)}>
          {t("common.back")}
        </Button>
      </div>
    );
  }
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white" data-testid="offline-player">
      <div className="flex items-center gap-3 px-3 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button type="button" className="min-h-[44px] rounded-full px-3 text-sm font-semibold hover:bg-white/10" onClick={() => navigate(-1)}>
          ← {t("common.back")}
        </button>
        <div className="min-w-0">
          <p className="truncate font-semibold">{it.title}</p>
          {it.subtitle && <p className="truncate text-xs text-white/60">{it.subtitle}</p>}
        </div>
      </div>
      <video ref={video} className="min-h-0 w-full flex-1 bg-black" src={offlineVideoUrl(it.id)} controls autoPlay playsInline poster={it.poster ?? undefined} />
    </div>
  );
}

/** Player menu section «Скачать на устройство». */
export function DeviceDownloadSection({
  source,
  title,
  subtitle,
  poster,
  compatUrl,
}: {
  source: PlaybackSource;
  title: string;
  subtitle: string | null;
  poster: string | null;
  /** At click time: the compat stream URL to save (from the start), or null to save the original file. */
  compatUrl: () => string | null;
}) {
  const { t, locale } = useI18n();
  useDevice(); // re-render on progress
  if (!deviceSupported || source.kind === "online") return null;
  const id = deviceId(source.media_id, source.episode_id, source.id);
  const saved = deviceItem(id);
  const job = deviceJob(id);
  const item = "flex min-h-[44px] w-full items-center gap-2 rounded-xl px-3 text-left text-sm hover:bg-white/10 disabled:opacity-60";
  return (
    <div className="border-t border-white/10 pt-1" data-testid="player-device-download">
      <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-white/55">{t("offline.device.download")}</p>
      {saved ? (
        <div className="space-y-1 px-3 pb-2 text-sm">
          <p className="font-semibold text-ok">{t("offline.device.saved", { size: formatBytes(saved.size, locale) })}</p>
          <Link to="/downloads#device" className="inline-flex min-h-[40px] items-center font-semibold text-accent">
            {t("offline.device.open")}
          </Link>
        </div>
      ) : job && !job.error ? (
        <div className="space-y-1 px-3 pb-2 text-sm">
          <p className="font-semibold">
            {t("offline.device.downloading")} {formatBytes(job.bytes, locale)}
            {job.total ? ` / ${formatBytes(job.total, locale)}` : ""}
          </p>
          <p className="text-xs text-white/60">{t("offline.device.keep_open")}</p>
          <button type="button" className="min-h-[40px] text-xs font-semibold text-white/70 hover:text-white" onClick={() => cancelDownload(id)}>
            {t("common.cancel")}
          </button>
        </div>
      ) : (
        <>
          {job?.error && <p className="px-3 text-xs text-danger">{t(job.error === "quota" ? "offline.device.quota" : "offline.device.failed")}</p>}
          <button
            type="button"
            role="menuitem"
            className={item}
            disabled={!source.stream_url && !source.compat_url}
            data-testid="player-device-download-start"
            onClick={() => {
              const compat = compatUrl();
              const url = compat ?? source.stream_url;
              if (!url) return;
              void downloadToDevice({
                mediaId: source.media_id,
                episodeId: source.episode_id,
                title,
                subtitle,
                poster,
                url,
                mode: compat ? "compat" : "original",
                duration: source.media_info?.duration_seconds ?? null,
              });
            }}
          >
            <PhoneIcon className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1">{t("offline.device.download")}</span>
          </button>
          <p className="px-3 pb-2 pt-1 text-xs leading-snug text-white/60">{t("offline.device.note")}</p>
        </>
      )}
    </div>
  );
}

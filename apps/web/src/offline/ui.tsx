// Offline UI: «Скачать на устройство» buttons (title page, episodes, season,
// player menu), the «На устройстве» list, the screen shown when the server is
// unreachable and the offline player.
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { QueryClient } from "@tanstack/react-query";
import type { MediaDetail, PlaybackSource } from "@martytv/contracts";
import { episodeCode, imageUrl, type ImageConfig } from "@martytv/media-types";
import { Logo, useI18n } from "@martytv/ui";
import { Button, Card } from "../components";
import { formatBytes } from "../admin/format";
import { TrashIcon, useNow } from "../downloads/ui";
import { PlayIcon } from "../icons";
import { useCatalogLang } from "../catalog/queries";
import { useActiveProfile } from "../watch/ActiveProfile";
import {
  cancelDownload, deviceId, deviceItem, offlineVideoUrl, removeFromDevice, retryDeviceDownload, saveOfflinePosition, startDeviceDownload,
  storagePersisted, unsupportedReason, useDevice, useDeviceItem, type DeviceItem, type DeviceRequest,
} from "./device";
import { isRunning, type SaveMode } from "./logic";
import { deviceView, seasonState, type Tone, type View } from "./view";

export const PhoneIcon = ({ className = "" }: { className?: string }) => (
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

const CheckMini = ({ className = "" }: { className?: string }) => (
  <svg className={className} width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12.5 10 17l9-10" />
  </svg>
);

/** What to save: a movie, or one episode (release_id: a specific release from the list). */
export interface SaveTarget {
  media_id: string;
  episode_id?: string | null;
  season_number?: number | null;
  episode_number?: number | null;
  title: string;
  subtitle?: string | null;
  poster?: string | null;
  release_id?: string | null;
}

/** A release-list target → what to save (title / poster from the cached media when known). */
export function saveTargetFor(
  qc: QueryClient,
  tg: { media_id: string; episode_id?: string; season_number?: number; episode_number?: number; label: string; detail?: string },
  releaseId: string,
): SaveTarget {
  const m = qc.getQueriesData<MediaDetail>({ queryKey: ["media", tg.media_id] }).find(([, d]) => d)?.[1];
  const cfg = qc.getQueryData<ImageConfig>(["catalog", "config"]);
  const code = tg.season_number != null && tg.episode_number != null ? episodeCode(tg.season_number, tg.episode_number) : null;
  return {
    media_id: tg.media_id,
    episode_id: tg.episode_id ?? null,
    season_number: tg.season_number ?? null,
    episode_number: tg.episode_number ?? null,
    title: m?.title ?? tg.label,
    subtitle: code ? [code, tg.detail].filter(Boolean).join(" · ") : null,
    poster: imageUrl(cfg, m?.poster_path, "w342"),
    release_id: releaseId,
  };
}

/** Starts (or retries) a device download with this page's profile and language. */
export function useSaveToDevice() {
  const { profileId } = useActiveProfile();
  const lang = useCatalogLang();
  return (tg: SaveTarget, extra: Partial<DeviceRequest> = {}) =>
    startDeviceDownload({
      mediaId: tg.media_id,
      episodeId: tg.episode_id ?? null,
      season: tg.season_number ?? null,
      episode: tg.episode_number ?? null,
      title: tg.title,
      subtitle: tg.subtitle ?? null,
      poster: tg.poster ?? null,
      releaseId: tg.release_id ?? null,
      profileId: profileId ?? null,
      lang,
      ...extra,
    });
}

const TONE: Record<Tone, string> = {
  idle: "border-border bg-surface/70 text-text hover:border-accent",
  progress: "border-accent/60 bg-accent/10 text-accent",
  wait: "border-border bg-surface-2 text-text/85",
  error: "border-danger/50 bg-danger/10 text-danger",
  done: "border-ok/50 bg-ok/10 text-ok",
};

function useAct() {
  const navigate = useNavigate();
  return (v: View, id: string, start: () => void) => {
    if (v.action === "start") start();
    else if (v.action === "open") navigate(`/offline/${encodeURIComponent(id)}`);
    else if (v.action === "retry") retryDeviceDownload(id);
    else navigate("/downloads#device");
  };
}

function ToneIcon({ tone, className = "" }: { tone: Tone; className?: string }) {
  return tone === "done" ? <CheckMini className={className} /> : <PhoneIcon className={className} />;
}

/** Title page: «Скачать на устройство» with live state (queued / N% / on device / failed + retry). */
export function SaveToDeviceButton({ target, className = "" }: { target: SaveTarget; className?: string }) {
  const { t, locale } = useI18n();
  const now = useNow(1000);
  const save = useSaveToDevice();
  const act = useAct();
  const id = deviceId(target.media_id, target.episode_id ?? null);
  const it = useDeviceItem(id);
  const [why, setWhy] = useState<string | null>(null);
  const unsupported = unsupportedReason();
  const v = deviceView(it, t, locale, now);
  const note = why ?? v.note;
  return (
    <div className={`min-w-0 ${className}`} data-testid="save-device" data-status={it?.status ?? "none"}>
      <button
        type="button"
        onClick={() => (unsupported ? setWhy(t(`devicedl.unsupported.${unsupported}`)) : act(v, id, () => save(target)))}
        data-testid="save-device-button"
        className={`relative inline-flex min-h-[48px] w-full items-center justify-center gap-2 overflow-hidden whitespace-nowrap rounded-xl border px-4 font-semibold backdrop-blur transition sm:w-auto sm:px-5 ${TONE[v.tone]} ${unsupported ? "opacity-70" : ""}`}
      >
        {v.percent != null && v.tone === "progress" && <span aria-hidden className="absolute inset-y-0 left-0 bg-accent/20 transition-[width]" style={{ width: `${v.percent}%` }} />}
        <ToneIcon tone={v.tone} className={`relative text-xl ${v.tone === "idle" ? "text-accent" : ""}`} />
        <span className="relative tabular-nums">{v.label}</span>
      </button>
      {note && (
        <p role={v.tone === "error" || why ? "alert" : undefined} className={`mt-1.5 max-w-sm text-xs leading-snug ${v.tone === "error" ? "text-danger" : "text-muted"}`} data-testid="save-device-note">
          {note}
        </p>
      )}
    </div>
  );
}

/** Episode row: a compact pill under the episode's meta («На устройство» / «42%» / «На устройстве»), same states. */
export function SaveEpisodeButton({ target, code }: { target: SaveTarget; code: string }) {
  const { t, locale } = useI18n();
  const now = useNow(1000);
  const save = useSaveToDevice();
  const act = useAct();
  const id = deviceId(target.media_id, target.episode_id ?? null);
  const it = useDeviceItem(id);
  const [why, setWhy] = useState<string | null>(null);
  const unsupported = unsupportedReason();
  const v = deviceView(it, t, locale, now);
  const note = why ?? v.note;
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => (unsupported ? setWhy(t(`devicedl.unsupported.${unsupported}`)) : act(v, id, () => save(target)))}
        aria-label={it ? `${code} · ${v.label}` : t("devicedl.save_episode", { code })}
        data-testid="episode-save-device"
        data-status={it?.status ?? "none"}
        className={`relative inline-flex min-h-[32px] max-w-full items-center gap-1.5 overflow-hidden rounded-full border px-3 text-xs font-semibold transition ${TONE[v.tone]}`}
      >
        {v.percent != null && v.tone === "progress" && <span aria-hidden className="absolute inset-y-0 left-0 bg-accent/20" style={{ width: `${v.percent}%` }} />}
        <PhoneIcon className={`relative shrink-0 text-sm ${v.tone === "idle" ? "text-accent" : ""}`} />
        <span className="relative truncate tabular-nums">{!it ? t("devicedl.save_short") : v.tone === "progress" && v.percent != null ? `${v.percent}%` : v.label}</span>
      </button>
      {note && <p className={`mt-1 text-xs leading-snug ${v.tone === "error" ? "text-danger" : "text-muted"}`}>{note}</p>}
    </div>
  );
}

/** Season: queue every episode (each its best release); shows N of M saved. */
export function SaveSeasonButton({
  mediaId,
  title,
  poster,
  episodes,
}: {
  mediaId: string;
  title: string;
  poster: string | null;
  episodes: { id: string; season_number: number; episode_number: number; name?: string | null; code: string }[];
}) {
  const { t } = useI18n();
  useDevice();
  const save = useSaveToDevice();
  const [why, setWhy] = useState<string | null>(null);
  const items = episodes.map((e) => deviceItem(deviceId(mediaId, e.id)));
  const st = seasonState(items);
  if (!episodes.length) return null;
  const unsupported = unsupportedReason();
  const all = st.saved === st.total;
  const running = st.running > 0;
  const label = all
    ? t("devicedl.season_state", { done: st.saved, total: st.total })
    : running
      ? t("devicedl.season_running", { done: st.saved, total: st.total })
      : st.saved > 0
        ? `${t("devicedl.save_season")} · ${st.saved}/${st.total}`
        : t("devicedl.save_season");
  return (
    <div className="min-w-0">
      <button
        type="button"
        data-testid="season-save-device"
        disabled={all || running}
        onClick={() => {
          if (unsupported) return setWhy(t(`devicedl.unsupported.${unsupported}`));
          for (const e of episodes) {
            const it = deviceItem(deviceId(mediaId, e.id));
            if (it && (it.status === "saved" || isRunning(it.status))) continue;
            save({ media_id: mediaId, episode_id: e.id, season_number: e.season_number, episode_number: e.episode_number, title, subtitle: [e.code, e.name].filter(Boolean).join(" · "), poster });
          }
        }}
        className={`inline-flex min-h-[40px] items-center gap-2 rounded-xl border px-3.5 text-sm font-semibold transition disabled:cursor-default ${all ? TONE.done : running ? TONE.progress : TONE.idle}`}
      >
        {all ? <CheckMini /> : <PhoneIcon className={running ? "" : "text-accent"} />}
        <span className="tabular-nums">{label}</span>
      </button>
      {why && (
        <p role="alert" className="mt-1.5 max-w-sm text-xs text-muted">
          {why}
        </p>
      )}
    </div>
  );
}

/** Saved items + running downloads, each playable offline. */
export function DeviceList({ empty = true }: { empty?: boolean }) {
  const { t, locale } = useI18n();
  const { items, totalBytes } = useDevice();
  const persisted = storagePersisted();
  if (!items.length) return empty ? <p className="text-sm text-muted" data-testid="device-empty">{t("devicedl.empty")}</p> : null;
  const busy = items.some((i) => isRunning(i.status));
  return (
    <div className="space-y-2" data-testid="device-downloads">
      {items.map((it) => (
        <DeviceRow key={it.id} it={it} />
      ))}
      <p className="pt-1 text-xs text-muted">{t("offline.device.total", { size: formatBytes(totalBytes, locale) })}</p>
      {busy && <p className="text-xs text-muted">{t("devicedl.keep_open")}</p>}
      {persisted === false && <p className="text-xs text-muted">{t("devicedl.not_persisted")}</p>}
    </div>
  );
}

function DeviceRow({ it }: { it: DeviceItem }) {
  const { t, locale } = useI18n();
  const now = useNow(1000);
  const v = deviceView(it, t, locale, now);
  const saved = it.status === "saved";
  const play = `/offline/${encodeURIComponent(it.id)}`;
  const sizeText = saved
    ? formatBytes(it.size, locale)
    : it.total
      ? t("devicedl.of", { done: formatBytes(it.bytes, locale), total: formatBytes(it.total, locale) })
      : it.bytes > 0
        ? formatBytes(it.bytes, locale)
        : null;
  const body = (
    <>
      <div className="h-16 w-11 shrink-0 overflow-hidden rounded-md bg-surface-2">
        {it.poster && <img src={it.poster} alt="" className="h-full w-full object-cover" loading="lazy" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{it.title}</p>
        {it.subtitle && <p className="truncate text-xs text-muted">{it.subtitle}</p>}
        <p className={`text-xs ${v.tone === "error" ? "text-danger" : v.tone === "progress" ? "text-accent" : v.tone === "done" ? "text-muted" : "text-text/80"}`}>
          {saved ? sizeText : [v.label, sizeText].filter(Boolean).join(" · ")}
        </p>
        {!saved && (v.percent != null || it.status === "downloading") && (
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className={`h-full ${v.percent == null ? "w-1/3 animate-pulse" : ""} ${v.tone === "error" ? "bg-danger" : "bg-accent"}`} style={v.percent != null ? { width: `${v.percent}%` } : undefined} />
          </div>
        )}
        {v.note && <p className="mt-1 text-xs leading-snug text-muted">{v.note}</p>}
        {it.mode === "compat" && !saved && it.status !== "failed" && <p className="mt-1 text-xs leading-snug text-muted">{t("devicedl.compat_note")}</p>}
      </div>
    </>
  );
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border p-2 pr-3 text-sm" data-testid="device-row" data-status={it.status}>
      {saved ? (
        <Link to={play} className="flex min-w-0 flex-1 items-center gap-3">
          {body}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3">{body}</div>
      )}
      {saved ? (
        <Link to={play} aria-label={t("offline.device.play")} data-testid="device-play" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent">
          <PlayIcon />
        </Link>
      ) : v.action === "retry" ? (
        <button type="button" data-testid="device-retry" className="min-h-[40px] shrink-0 rounded-lg px-2 text-xs font-semibold text-accent hover:bg-surface-2" onClick={() => retryDeviceDownload(it.id)}>
          {it.status === "paused" ? t("devicedl.resume") : t("devicedl.retry")}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={isRunning(it.status) ? t("common.cancel") : t("offline.device.delete")}
        data-testid="device-delete"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted hover:text-danger"
        onClick={() => (isRunning(it.status) ? cancelDownload(it.id) : void removeFromDevice(it.id))}
      >
        <TrashIcon />
      </button>
    </div>
  );
}

/** «На устройстве» card (Downloads page): the list, or why this browser can't save. */
export function DeviceCard() {
  const { t } = useI18n();
  const unsupported = unsupportedReason();
  return (
    <Card className="space-y-3">
      <p id="device" className="flex items-center gap-2 font-semibold">
        <PhoneIcon className="text-lg text-accent" />
        {t("offline.device.title")}
      </p>
      {unsupported ? <p className="text-sm text-muted" data-testid="device-unsupported">{t(`devicedl.unsupported.${unsupported}`)}</p> : <DeviceList />}
    </Card>
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
  const saved = it?.status === "saved" ? it : null;
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const v = video.current;
    if (!v || !saved) return;
    const start = saved.position && (!saved.duration || saved.position < saved.duration - 60) ? saved.position : 0;
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
    const onError = () => setFailed(true);
    v.addEventListener("loadedmetadata", onMeta, { once: true });
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("error", onError);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("error", onError);
      saveOfflinePosition(id, v.currentTime);
    };
  }, [id, saved]);
  if (!saved) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p>{t("offline.device.missing")}</p>
        <Button variant="secondary" onClick={() => navigate(-1)}>
          {t("common.back")}
        </Button>
      </div>
    );
  }
  // Without a controlling service worker (first visit, hard reload) the video URL can't be served.
  const noSw = typeof navigator !== "undefined" && "serviceWorker" in navigator && !navigator.serviceWorker.controller;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white" data-testid="offline-player">
      <div className="flex items-center gap-3 px-3 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button type="button" className="min-h-[44px] rounded-full px-3 text-sm font-semibold hover:bg-white/10" onClick={() => navigate(-1)}>
          ← {t("common.back")}
        </button>
        <div className="min-w-0">
          <p className="truncate font-semibold">{saved.title}</p>
          {saved.subtitle && <p className="truncate text-xs text-white/60">{saved.subtitle}</p>}
        </div>
      </div>
      {(failed || noSw) && (
        <p role="alert" className="mx-3 mb-2 rounded-lg bg-white/10 px-3 py-2 text-xs" data-testid="offline-player-error">
          {t("devicedl.reload")}{" "}
          <button type="button" className="font-semibold underline" onClick={() => window.location.reload()}>
            {t("common.retry")}
          </button>
        </p>
      )}
      <video ref={video} className="min-h-0 w-full flex-1 bg-black" src={offlineVideoUrl(saved.id)} controls autoPlay playsInline poster={saved.poster ?? undefined} />
    </div>
  );
}

/** Player menu section «Скачать на устройство»: saves what plays here (original, or the compat stream with its audio). */
export function DeviceDownloadSection({
  source,
  title,
  subtitle,
  poster,
  playing,
}: {
  source: PlaybackSource;
  title: string;
  subtitle: string | null;
  poster: string | null;
  /** At click time: what the player plays (compat: with which audio track). */
  playing: () => { mode: SaveMode; audio: number | null };
}) {
  const { t, locale } = useI18n();
  const now = useNow(1000);
  const save = useSaveToDevice();
  const navigate = useNavigate();
  const id = deviceId(source.media_id, source.episode_id);
  const it = useDeviceItem(id);
  if (source.kind === "online" || !source.media_id) return null;
  const unsupported = unsupportedReason();
  const v = deviceView(it, t, locale, now);
  const item = "flex min-h-[44px] w-full items-center gap-2 rounded-xl px-3 text-left text-sm hover:bg-white/10 disabled:opacity-60";
  return (
    <div className="pb-1" data-testid="player-device-download" data-status={it?.status ?? "none"}>
      <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-white/55">{t("devicedl.save")}</p>
      {unsupported ? (
        <p className="px-3 pb-2 text-xs leading-snug text-white/70">{t(`devicedl.unsupported.${unsupported}`)}</p>
      ) : (
        <>
          <button
            type="button"
            role="menuitem"
            className={item}
            data-testid="player-device-download-start"
            onClick={() => {
              if (v.action === "start") {
                const p = playing();
                save(
                  { media_id: source.media_id!, episode_id: source.episode_id, title, subtitle, poster, release_id: source.release.id },
                  { sourceId: source.id, mode: p.mode, audio: p.audio },
                );
              } else if (v.action === "retry") retryDeviceDownload(id);
              else if (v.action === "open") navigate(`/offline/${encodeURIComponent(id)}`);
              else navigate("/downloads#device");
            }}
          >
            {v.tone === "done" ? <CheckMini className="shrink-0 text-ok" /> : <PhoneIcon className="shrink-0 text-accent" />}
            <span className={`min-w-0 flex-1 tabular-nums ${v.tone === "error" ? "text-danger" : v.tone === "done" ? "text-ok" : ""}`}>
              {v.action === "start" ? t("devicedl.save") : v.action === "open" ? `${v.label} · ${t("devicedl.play")}` : v.label}
            </span>
          </button>
          {v.percent != null && v.tone === "progress" && (
            <div className="mx-3 mb-1 h-1.5 overflow-hidden rounded-full bg-white/15">
              <div className="h-full bg-accent" style={{ width: `${v.percent}%` }} />
            </div>
          )}
          <p className="px-3 pb-2 pt-0.5 text-xs leading-snug text-white/60">
            {v.note ?? (it && isRunning(it.status) ? t("devicedl.keep_open") : !it ? t("offline.device.note") : null)}
          </p>
        </>
      )}
    </div>
  );
}

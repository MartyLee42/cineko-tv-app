// Player menu «Скачать»: to this device (offline/ui.tsx) and to the server. The
// source id is known, so POST /downloads directly; once requested, the menu
// shows the download's live state instead.
import { Link } from "react-router";
import type { PlaybackSource } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";
import { CheckIcon } from "../icons";
import { apiErrorCode } from "../play/queries";
import { canDownloadSeason, chipInfo, createErrorKey, progressPercent } from "./format";
import { useCreateDownload } from "./queries";
import { DownloadProgress, ServerDownloadIcon, useNow } from "./ui";
import { DeviceDownloadSection } from "../offline/ui";

/** Badge on the player's menu button: "42%" while downloading, "✓" when on the server. */
export function downloadBadge(s: PlaybackSource): string | null {
  const d = s.download;
  if (!d) return null;
  return d.status === "done" ? "✓" : d.status === "downloading" ? `${progressPercent(d)}%` : null;
}

export interface DeviceContext {
  title: string;
  subtitle: string | null;
  poster: string | null;
  /** At click time: what the player plays (compat: with which audio track). */
  playing: () => { mode: "original" | "compat"; audio: number | null };
}

export function PlayerDownloadMenu({ source, onClose, device }: { source: PlaybackSource; onClose: () => void; device?: DeviceContext }) {
  const { t, locale } = useI18n();
  const now = useNow();
  const create = useCreateDownload();
  const d = source.download ?? null;
  const season = !!source.episode_id && canDownloadSeason(source.release);
  const start = (all: boolean) => create.mutate({ source_id: source.id, ...(all && { season: true }) });
  const item = "flex min-h-[44px] w-full items-center gap-2 rounded-xl px-3 text-left text-sm hover:bg-white/10 disabled:opacity-60";

  return (
    <div
      className="pointer-events-auto absolute bottom-[calc(6.5rem+env(safe-area-inset-bottom))] right-[max(env(safe-area-inset-right),0.75rem)] z-10 max-h-[60vh] w-72 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-2xl border border-white/10 bg-neutral-900/95 p-1.5 text-white shadow-2xl backdrop-blur sm:right-5"
      role="menu"
      aria-label={t("devicedl.menu")}
      data-testid="player-menu-download"
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      {device && <DeviceDownloadSection source={source} {...device} />}
      <p className={`px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-white/55 ${device ? "border-t border-white/10" : ""}`}>{t("downloads.download_to_server")}</p>
      {d && d.status !== "failed" ? (
        <div className="space-y-2 px-3 pb-2 pt-1" data-testid="player-download-state" data-status={d.status}>
          <p className={`flex items-center gap-1.5 text-sm font-semibold ${d.status === "done" ? "text-ok" : ""}`}>
            {d.status === "done" ? <CheckIcon /> : <ServerDownloadIcon />}
            <span className="min-w-0">{chipInfo(d, t, locale, now).text}</span>
          </p>
          {d.status !== "done" && <DownloadProgress d={d} />}
          <Link to="/downloads" role="menuitem" className="inline-flex min-h-[40px] items-center text-sm font-semibold text-accent">
            {t("downloads.open")}
          </Link>
        </div>
      ) : (
        <>
          {d?.status === "failed" && <p className="px-3 pb-1 text-xs text-danger">{t("downloads.status.failed")}</p>}
          <button type="button" role="menuitem" className={item} disabled={create.isPending} onClick={() => start(false)} data-testid="player-download-start">
            <ServerDownloadIcon className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1">{season ? t("downloads.download_episode") : t("downloads.download_to_server")}</span>
          </button>
          {season && (
            <button type="button" role="menuitem" className={item} disabled={create.isPending} onClick={() => start(true)} data-testid="player-download-season">
              <ServerDownloadIcon className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1">{t("downloads.download_season")}</span>
            </button>
          )}
          {create.error ? (
            <p role="alert" className="px-3 pb-2 pt-1 text-xs text-danger">{t(createErrorKey(apiErrorCode(create.error)))}</p>
          ) : (
            <p className="px-3 pb-2 pt-1 text-xs leading-snug text-white/60">{t("downloads.player.note")}</p>
          )}
        </>
      )}
    </div>
  );
}

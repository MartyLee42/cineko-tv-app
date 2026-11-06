import { Link, useLocation } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DeviceState } from "@martytv/contracts";
import { StatusDot, useI18n } from "@martytv/ui";
import { useDevices } from "../queries";
import { Poster } from "../catalog/components";
import { PauseIcon, PlayIcon, RemoteIcon } from "../icons";
import { focusDevice, remoteControls, toggleCommand, type RemoteCmd } from "./logic";
import { sendCommand, useDeviceStates, useLastUsedDevice } from "./state";
import { VolumeStepButtons } from "./VolumeControls";

/** The TV shortcuts point at (last used if online, else the only online TV) and its live state. */
export function useFocusTv() {
  const { data: devices } = useDevices();
  const states = useDeviceStates(devices);
  const lastUsed = useLastUsedDevice();
  const live = (devices ?? []).map((d) => ({ ...d, online: states[d.id]?.online ?? d.online }));
  const device = focusDevice(live, lastUsed);
  return device ? { device, state: states[device.id]?.state ?? null } : null;
}

/** "Now on Living room" chip on a title page when the TV shows that title. */
export function NowOnTvChip({ mediaId }: { mediaId: string }) {
  const { t } = useI18n();
  const tv = useFocusTv();
  const s = tv?.state;
  if (!tv || (s?.playback?.media_id ?? s?.media_id) !== mediaId) return null;
  return (
    <Link
      to={`/remote/${tv.device.id}`}
      data-testid="now-on-tv-chip"
      className="inline-flex min-h-[44px] items-center gap-2 rounded-full border border-border bg-surface/70 px-4 text-sm font-semibold backdrop-blur hover:border-accent"
    >
      <StatusDot online />
      {t("remote.now_on_tv", { tv: tv.device.name })}
    </Link>
  );
}

/** Play/pause and «Тише» / «Громче» on the mini-bar (the full remote is a tap away). */
function BarControls({ deviceId, s }: { deviceId: string; s: DeviceState }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const c = remoteControls(s);
  const toggle = useMutation({ mutationFn: (x: RemoteCmd) => sendCommand(qc, deviceId, x.type, x.payload as never) });
  return (
    <>
      {c && (
        <button
          type="button"
          aria-label={c.paused ? t("remote.play") : t("remote.pause")}
          title={c.paused ? t("remote.play") : t("remote.pause")}
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(toggleCommand(c))}
          data-testid="bar-playpause"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-xl text-on-accent transition hover:bg-accent-strong disabled:opacity-60"
        >
          {c.paused ? <PlayIcon className="translate-x-0.5" /> : <PauseIcon />}
        </button>
      )}
      <VolumeStepButtons deviceId={deviceId} s={s} />
    </>
  );
}

/** Floating mini-bar (above the bottom nav on phones) for the title on the TV. */
export function NowOnTvBar() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const tv = useFocusTv();
  const s = tv?.state;
  const mediaId = s?.playback?.media_id ?? s?.media_id;
  const video = s?.video ?? null;
  const channel = s?.live ?? null;
  if (!tv || !s || (!mediaId && !video && !channel) || pathname.startsWith("/remote")) return null;
  const title = video ? (video.title ?? "YouTube") : channel ? `${channel.number} · ${channel.name}` : (s.playback?.title ?? s.title ?? "");
  const sub = channel
    ? (channel.programme ?? null)
    : video
    ? (video.channel_name ?? "YouTube")
    : (s.playback?.episode_label ?? (s.season_number ? t("catalog.detail.season", { n: s.season_number }) : null));

  return (
    <>
      <div className="h-16 md:hidden" aria-hidden />
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-20 flex justify-center px-3 md:inset-x-auto md:bottom-6 md:right-6 md:px-0">
        <div className="pointer-events-auto flex w-full max-w-md items-center gap-1.5 rounded-2xl border border-border bg-surface-2/95 p-2 shadow-2xl shadow-black/50 backdrop-blur transition hover:border-accent md:w-[26rem]">
        <Link
          to={`/remote/${tv.device.id}`}
          data-testid="now-on-tv-bar"
          data-video-id={video?.video_id}
          className="flex min-w-0 flex-1 items-center gap-3"
        >
          {video ? (
            <span className="aspect-video w-16 shrink-0 overflow-hidden rounded-lg bg-surface">
              {video.thumbnail && <img src={video.thumbnail} alt="" className="h-full w-full object-cover" />}
            </span>
          ) : channel ? (
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-surface text-[10px] font-bold uppercase text-danger">{t("iptv.live")}</span>
          ) : (
            <Poster item={{ id: mediaId!, title, poster_path: s.poster_path ?? null }} sizes="40px" className="w-9 shrink-0 !rounded-lg" />
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-accent">
              <StatusDot online />
              <span className="truncate">{t("remote.now_on_tv", { tv: tv.device.name })}</span>
            </span>
            <span className="block truncate text-sm font-semibold">{title}</span>
            {sub && <span className="block truncate text-xs text-muted">{sub}</span>}
          </span>
          <RemoteIcon className="hidden shrink-0 text-xl text-muted sm:block" />
        </Link>
        <BarControls deviceId={tv.device.id} s={s} />
        </div>
      </div>
    </>
  );
}

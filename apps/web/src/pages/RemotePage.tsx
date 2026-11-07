import { useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Device, DeviceState, PlaybackState, VideoPlaybackState } from "@martytv/contracts";
import { ProfileAvatar, Spinner, StatusDot, useI18n, type MessageKey } from "@martytv/ui";
import { useDevices, useProfiles } from "../queries";
import { AllDevicesToggle, isForeign, usePickerDevices, useWatchForeign } from "../remote/AllDevicesToggle";
import { Button, Card, ErrorText, Select, timeAgo } from "../components";
import { Poster } from "../catalog/components";
import { BackIcon, CastIcon, ChevronRight, ForwardIcon, NextIcon, PauseIcon, PlayIcon } from "../icons";
import { VolumeRow } from "../remote/VolumeControls";
import { SourceCard } from "../play/SourceSwitcher";
import {
  errorMessage,
  errorOutcome,
  formatClock,
  jumpCommand,
  remoteControls,
  screenKey,
  toggleCommand,
  videoNextCommand,
  videoQualityCommand,
  videoQualityOptions,
  videoStatus,
  type RemoteCmd,
  type RemoteControls,
  type VideoQuality,
} from "../remote/logic";
import { sendCommand, setLastUsedDevice, useDeviceState, useLastUsedDevice } from "../remote/state";
import { remoteTrackLabel } from "../play/releases";
import { useVideoDetail } from "../video/queries";
import { watchHref } from "../video/ui";

/** /remote — jumps to the last used (or first) TV. */
export function RemoteIndex() {
  const { data: devices, isPending } = useDevices();
  const lastUsed = useLastUsedDevice();
  if (isPending) return <Spinner />;
  const pick = devices?.find((d) => d.id === lastUsed) ?? devices?.find((d) => d.online) ?? devices?.[0];
  return <Navigate to={pick ? `/remote/${pick.id}` : "/devices"} replace />;
}

export function RemotePage() {
  const { deviceId = "" } = useParams();
  const { t } = useI18n();
  const { data: devices, isPending, error } = usePickerDevices(deviceId);
  const device = devices?.find((d) => d.id === deviceId);

  if (isPending) {
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-xl space-y-4" data-testid="remote">
      <ErrorText error={error} />
      {devices && devices.filter((d) => !isForeign(d)).length > 1 && <DeviceSwitcher devices={devices.filter((d) => !isForeign(d))} current={deviceId} />}
      {devices && <AllDevicesToggle devices={devices} linkRemote current={deviceId} />}
      {device ? (
        <Remote key={device.id} device={device} />
      ) : (
        <Card className="space-y-4 text-center">
          <p className="text-muted">{t("remote.device_not_found")}</p>
          <Link to="/devices" className="inline-flex min-h-[44px] items-center rounded-xl bg-surface-2 px-4 font-semibold">
            {t("nav.devices")}
          </Link>
        </Card>
      )}
    </div>
  );
}

function DeviceSwitcher({ devices, current }: { devices: Device[]; current: string }) {
  return (
    <nav className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0" aria-label="TV">
      {devices.map((d) => {
        const on = d.id === current;
        return (
          <Link
            key={d.id}
            to={`/remote/${d.id}`}
            replace
            aria-current={on ? "page" : undefined}
            className={`flex min-h-[40px] shrink-0 items-center gap-2 rounded-full border px-3.5 text-sm font-semibold transition ${
              on ? "border-accent bg-accent/15 text-text" : "border-border bg-surface text-text/80 hover:border-muted"
            }`}
          >
            <StatusDot online={d.online} />
            <span className="max-w-[10rem] truncate">{d.name}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function Remote({ device: d }: { device: Device }) {
  const { t, locale } = useI18n();
  const live = useDeviceState(d.id);
  const { data: profiles } = useProfiles();
  const online = live.data?.online ?? d.online;
  const s = online ? (live.data?.state ?? null) : null;

  useWatchForeign(d);
  // Opening a TV's remote makes it the default target for "Send to TV".
  useEffect(() => setLastUsedDevice(d.id), [d.id]);

  return (
    <>
      <Card className="space-y-3">
        <div className="flex items-start gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-surface-2 text-2xl text-text/80">
            <CastIcon />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold">{d.name}</h1>
            <p className="mt-0.5 flex items-center gap-2 text-sm text-muted" data-testid="remote-status">
              <StatusDot online={online} />
              {online ? t("common.online") : t("devices.last_seen", { when: timeAgo(d.last_seen_at, locale) })}
              {online && s && (
                <>
                  <span aria-hidden>·</span>
                  <span data-testid="remote-screen">{t(screenKey(s.screen))}</span>
                </>
              )}
            </p>
          </div>
          {live.isFetching && <Spinner size={18} />}
        </div>
        {online && s?.profile_name && (
          <p className="flex items-center gap-2 text-sm">
            <ProfileAvatar
              name={s.profile_name}
              color={profiles?.find((x) => x.id === s.profile_id)?.color ?? "#64748b"}
              avatar={profiles?.find((x) => x.id === s.profile_id)?.avatar}
              size={24}
              className="!rounded-full"
            />
            {t("remote.profile", { name: s.profile_name })}
          </p>
        )}
        {!online && <p className="rounded-xl bg-surface-2 px-3.5 py-3 text-sm text-muted">{t("remote.offline_hint")}</p>}
      </Card>

      {online && <NowOnTv tv={d.name} s={s} />}
      {online && s?.playback && <SourceCard deviceId={d.id} s={s} />}
      <Playback deviceId={d.id} online={online} s={s} />
      <MessageCard device={d} online={online} />
    </>
  );
}

function NowOnTv({ tv, s }: { tv: string; s: DeviceState | null }) {
  const { t } = useI18n();
  if (s?.video) return <VideoNowOnTv tv={tv} v={s.video} />;
  const title = s?.playback?.title ?? s?.title;
  const mediaId = s?.playback?.media_id ?? s?.media_id;
  if (s?.live) {
    return (
      <Card>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-accent">{t("remote.now_on_tv", { tv })}</h2>
        <p className="mt-1 text-lg font-bold">
          {s.live.number} · {s.live.name}
        </p>
        {s.live.programme && <p className="text-sm text-muted">{s.live.programme}</p>}
      </Card>
    );
  }
  if (!s || !mediaId || !title) {
    return (
      <Card>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{t("remote.now_on_tv", { tv })}</h2>
        <p className="mt-2 text-muted">{t("remote.nothing")}</p>
      </Card>
    );
  }
  const p = s.playback;
  const sub = [
    s.kind ? t(`catalog.kind.${s.kind}` as MessageKey) : null,
    p?.episode_label ?? (s.season_number ? t("catalog.detail.season", { n: s.season_number }) : null),
  ].filter(Boolean);
  const pct = p?.duration_seconds ? Math.max(0, Math.min(100, (p.position_seconds / p.duration_seconds) * 100)) : null;
  const status = p
    ? p.buffering
      ? t("remote.buffering")
      : p.paused
        ? t("player.paused")
        : t("player.playing")
    : s.screen === "player"
      ? t("player.preparing_on_tv")
      : null;

  return (
    <Link
      to={`/title/${mediaId}`}
      data-testid="now-on-tv"
      data-media-id={mediaId}
      className="group flex items-center gap-4 rounded-2xl border border-border bg-surface p-3 transition hover:border-accent sm:p-4"
    >
      <Poster item={{ id: mediaId, title, poster_path: s.poster_path ?? null }} sizes="96px" className="w-20 shrink-0 shadow-lg shadow-black/40 sm:w-24" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-accent">
          <StatusDot online />
          {t("remote.now_on_tv", { tv })}
        </p>
        <h2 className="mt-1 line-clamp-2 text-lg font-bold leading-snug group-hover:text-accent-strong">{title}</h2>
        {sub.length > 0 && <p className="mt-0.5 line-clamp-2 text-sm text-muted">{sub.join(" · ")}</p>}
        {status && (
          <p className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-text/85" data-testid="now-status">
            {(p?.buffering || (!p && s.screen === "player")) && <Spinner size={12} />}
            {status}
          </p>
        )}
        {p && (
          <div className="mt-2">
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${pct ?? 0}%` }} />
            </div>
            <p className="mt-1 flex justify-between text-[11px] tabular-nums text-muted">
              <span>{formatClock(p.position_seconds)}</span>
              <span>{p.duration_seconds ? `−${formatClock(Math.max(0, p.duration_seconds - p.position_seconds))}` : "--:--"}</span>
            </p>
          </div>
        )}
      </div>
      <ChevronRight className="shrink-0 text-xl text-muted" />
    </Link>
  );
}

function Playback({ deviceId, online, s }: { deviceId: string; online: boolean; s: DeviceState | null }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const p = s?.playback ?? null;
  const v = s?.video ?? null;
  const c = online ? remoteControls(s) : null;
  const enabled = !!c;
  // While the TV buffers or prepares, only play/pause (and stop) stay live.
  const steady = enabled && !c.buffering;
  // A live channel: play/pause only (no seeking).
  const seekable = steady && c.kind !== "live";
  const cmd = useMutation({
    mutationFn: (x: RemoteCmd) => sendCommand(qc, deviceId, x.type, x.payload as never),
  });
  const run = (x: RemoteCmd) => {
    if (!cmd.isPending) cmd.mutate(x);
  };
  const failure = cmd.error ? errorOutcome(cmd.error) : null;
  const idle = !online
    ? t("player.controls_idle")
    : v?.error
      ? t("remote.video.failed")
      : v
        ? t("remote.video.preparing")
        : s?.screen === "player"
          ? t("player.preparing_on_tv")
          : t("player.controls_idle");

  return (
    <div data-testid="remote-playback" data-kind={c?.kind ?? ""}>
    <Card className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-bold">{t("remote.playback")}</h2>
        {c?.buffering && <span className="text-sm text-muted">{t("remote.buffering")}</span>}
      </div>
      {!enabled && (
        <p className="rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted" data-testid="playback-soon">
          {idle}
        </p>
      )}
      <fieldset disabled={!enabled || cmd.isPending} className={`space-y-5 ${enabled ? "" : "opacity-40"}`}>
        {c?.kind === "live" && s?.live ? (
          <p className="flex items-center gap-2 text-sm font-semibold" data-testid="remote-live">
            <span className="rounded bg-danger/15 px-1.5 py-0.5 text-[11px] uppercase tracking-wider text-danger">{t("iptv.live")}</span>
            <span className="truncate">
              {s.live.number} · {s.live.name}
            </span>
          </p>
        ) : (
          <fieldset disabled={!steady} className={`space-y-5 transition-opacity ${enabled && !steady ? "opacity-50" : ""}`}>
            <SeekBar c={c} onSeek={(pos) => run({ type: "media.seek", payload: { position_seconds: pos } })} />
          </fieldset>
        )}
        <div className="flex items-center justify-center gap-3 sm:gap-5">
          <RoundButton disabled={!seekable} label={t("remote.back_10")} onClick={() => c && run(jumpCommand(c, -10))}>
            <BackIcon />
            <span className="absolute text-[9px] font-bold">10</span>
          </RoundButton>
          <RoundButton big label={c?.paused === false ? t("remote.pause") : t("remote.play")} onClick={() => c && run(toggleCommand(c))}>
            {c?.paused === false ? <PauseIcon /> : <PlayIcon className="translate-x-0.5" />}
          </RoundButton>
          <RoundButton disabled={!seekable} label={t("remote.forward_30")} onClick={() => c && run(jumpCommand(c, 30))}>
            <ForwardIcon />
            <span className="absolute text-[9px] font-bold">30</span>
          </RoundButton>
        </div>
        {p?.episode_id && (
          <Button variant="secondary" className="w-full" disabled={!steady} onClick={() => run({ type: "media.next_episode", payload: undefined })}>
            <NextIcon />
            {t("remote.next_episode")}
          </Button>
        )}
        {p && (
          <fieldset disabled={!steady} className={`grid gap-3 transition-opacity sm:grid-cols-2 ${steady ? "" : "opacity-50"}`}>
            <TrackSelect
              label={t("remote.audio")}
              tracks={p?.audio_tracks}
              value={p?.audio_track_id ?? ""}
              onChange={(id) => run({ type: "playback.set_audio", payload: { track_id: id } })}
            />
            <TrackSelect
              label={t("remote.subtitles")}
              tracks={p?.subtitle_tracks}
              value={p?.subtitle_track_id ?? ""}
              offLabel={t("remote.subtitles_off")}
              onChange={(id) => run({ type: "playback.set_subtitles", payload: { track_id: id } })}
            />
          </fieldset>
        )}
        {v && c?.kind === "video" && <VideoExtras v={v} steady={steady} run={run} />}
      </fieldset>
      {/* The TV's level: also with nothing playing (kept for the next film). */}
      {online && <VolumeRow deviceId={deviceId} s={s} />}
      {/* A failed video can still be stopped. */}
      {online && v && (
        <Button variant="secondary" className="w-full" disabled={cmd.isPending} onClick={() => run({ type: "media.stop", payload: undefined })} data-testid="remote-video-stop">
          {t("remote.video.stop")}
        </Button>
      )}
      {failure?.kind === "error" && (
        <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          {errorMessage(failure.code, t)}
        </p>
      )}
    </Card>
    </div>
  );
}

/** «Видео» on the TV: quality and what to play next (related videos, or pick one in «Видео»). */
function VideoExtras({ v, steady, run }: { v: VideoPlaybackState; steady: boolean; run: (x: RemoteCmd) => void }) {
  const { t } = useI18n();
  const options = videoQualityOptions(v);
  const detail = useVideoDetail(v.video_id);
  const related = (detail.data?.related ?? []).filter((r) => !r.live && !r.upcoming && r.id !== v.video_id).slice(0, 6);
  return (
    <div className="space-y-4">
      {options.length > 0 && (
        <label className="block space-y-1.5">
          <span className="text-sm text-muted">{t("remote.video.quality")}</span>
          <Select
            value={v.quality != null ? String(v.quality) : ""}
            disabled={!steady}
            data-testid="remote-video-quality"
            onChange={(e) => e.target.value && run(videoQualityCommand(v, Number(e.target.value) as VideoQuality))}
          >
            {v.quality == null && <option value="">—</option>}
            {options.map((q) => (
              <option key={q} value={q}>
                {q}p
              </option>
            ))}
          </Select>
        </label>
      )}
      <div className="space-y-2" data-testid="remote-video-next">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-muted">{t("remote.video.up_next")}</h3>
          <Link to="/video" className="inline-flex min-h-[40px] items-center text-sm font-semibold text-accent hover:underline">
            {t("remote.video.pick")}
          </Link>
        </div>
        {related.length > 0 && (
          <ul className="space-y-1.5">
            {related.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => run(videoNextCommand(r.id))}
                  data-testid="remote-video-related"
                  data-video-id={r.id}
                  className="flex w-full items-center gap-3 rounded-xl p-1.5 text-left transition hover:bg-surface-2"
                >
                  <img src={r.thumbnail} alt="" loading="lazy" className="aspect-video w-24 shrink-0 rounded-lg bg-surface-2 object-cover" />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-sm font-semibold leading-snug">{r.title}</span>
                    <span className="block truncate text-xs text-muted">{r.channel_name}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The YouTube video on the TV: thumbnail, title, channel, status and progress. */
function VideoNowOnTv({ tv, v }: { tv: string; v: VideoPlaybackState }) {
  const { t } = useI18n();
  const st = videoStatus(v);
  const status = st === "error" ? t("remote.video.failed") : st === "loading" ? t("remote.buffering") : st === "paused" ? t("player.paused") : t("player.playing");
  const pct = v.duration_seconds ? Math.max(0, Math.min(100, (v.position_seconds / v.duration_seconds) * 100)) : 0;
  return (
    <Link
      to={watchHref(v.video_id)}
      data-testid="now-on-tv"
      data-video-id={v.video_id}
      className="group flex items-center gap-4 rounded-2xl border border-border bg-surface p-3 transition hover:border-accent sm:p-4"
    >
      <span className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-xl bg-surface-2 shadow-lg shadow-black/40 sm:w-36">
        {v.thumbnail && <img src={v.thumbnail} alt="" className="h-full w-full object-cover" data-testid="now-on-tv-thumb" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-accent">
          <StatusDot online />
          <span className="truncate">{t("remote.now_on_tv", { tv })}</span>
        </p>
        <h2 className="mt-1 line-clamp-2 text-base font-bold leading-snug group-hover:text-accent-strong" data-testid="now-on-tv-title">
          {v.title ?? t("remote.video.label")}
        </h2>
        <p className="mt-0.5 truncate text-sm text-muted">{[v.channel_name, t("remote.video.label")].filter(Boolean).join(" · ")}</p>
        <p className={`mt-1.5 flex items-center gap-1.5 text-xs font-semibold ${st === "error" ? "text-danger" : "text-text/85"}`} data-testid="now-status">
          {st === "loading" && <Spinner size={12} />}
          {status}
        </p>
        {st !== "error" && (
          <div className="mt-2">
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1 flex justify-between text-[11px] tabular-nums text-muted">
              <span>{formatClock(v.position_seconds)}</span>
              <span>{v.duration_seconds ? `−${formatClock(Math.max(0, v.duration_seconds - v.position_seconds))}` : "--:--"}</span>
            </p>
          </div>
        )}
      </div>
      <ChevronRight className="shrink-0 text-xl text-muted" />
    </Link>
  );
}

function SeekBar({ c, onSeek }: { c: RemoteControls | null; onSeek: (pos: number) => void }) {
  const { t } = useI18n();
  const duration = c?.duration ?? 0;
  const [drag, setDrag] = useState<number | null>(null);
  const pos = drag ?? c?.position ?? 0;
  const commit = () => {
    if (drag != null) onSeek(Math.round(drag));
    setDrag(null);
  };
  return (
    <div>
      <input
        type="range"
        min={0}
        max={duration || 1}
        step={1}
        value={Math.min(pos, duration || 1)}
        disabled={!duration}
        aria-label={t("remote.seek")}
        aria-valuetext={formatClock(pos)}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={() => setDrag(null)}
        data-testid="remote-seek"
        className="h-11 w-full cursor-pointer accent-accent disabled:cursor-not-allowed"
      />
      <div className="-mt-1 flex justify-between text-xs tabular-nums text-muted">
        <span data-testid="remote-position">{formatClock(c ? pos : null)}</span>
        <span>{formatClock(c?.duration)}</span>
      </div>
    </div>
  );
}

function RoundButton({
  label,
  big,
  disabled,
  onClick,
  children,
}: {
  label: string;
  big?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`relative flex items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${
        big ? "h-16 w-16 bg-accent text-3xl text-on-accent hover:bg-accent-strong" : "h-14 w-14 bg-surface-2 text-2xl hover:bg-border"
      }`}
    >
      {children}
    </button>
  );
}

function TrackSelect({
  label,
  tracks,
  value,
  offLabel,
  onChange,
}: {
  label: string;
  tracks: PlaybackState["audio_tracks"];
  value: string;
  offLabel?: string;
  onChange: (id: string | null) => void;
}) {
  const { locale } = useI18n();
  return (
    <label className="block space-y-1.5">
      <span className="text-sm text-muted">{label}</span>
      <Select value={value} onChange={(e) => onChange(e.target.value || null)}>
        {offLabel ? <option value="">{offLabel}</option> : !tracks?.length && <option value="">—</option>}
        {tracks?.map((tr) => (
          <option key={tr.id} value={tr.id}>
            {remoteTrackLabel(tr, locale)}
          </option>
        ))}
      </Select>
    </label>
  );
}

function MessageCard({ device: d, online }: { device: Device; online: boolean }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const ping = useMutation({
    mutationFn: () => sendCommand(qc, d.id, "device.show_message", { text: "👋 Hello from Cineko" }),
  });
  const failure = ping.error ? errorOutcome(ping.error) : null;
  return (
    <div className="flex flex-wrap items-center gap-3 px-1">
      <Button variant="secondary" disabled={!online} busy={ping.isPending} onClick={() => ping.mutate()}>
        {t("devices.send_message")}
      </Button>
      <Link to="/devices" className="ml-auto inline-flex min-h-[44px] items-center text-sm font-semibold text-muted hover:text-text">
        {t("nav.devices")}
      </Link>
      {ping.isSuccess && <p className="w-full text-sm text-muted">{t("devices.message_sent")}</p>}
      {failure?.kind === "error" && <p className="w-full text-sm text-danger">{errorMessage(failure.code, t)}</p>}
    </div>
  );
}

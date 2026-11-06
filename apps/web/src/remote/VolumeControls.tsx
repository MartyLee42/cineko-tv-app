// The TV's volume on the phone remote (playback.set_volume): «Тише» / a bar
// to tap or drag / «Громче» / «Без звука». Optimistic: the bar moves at once,
// then the TV's reported state (device.state, the ack's result) is the truth.
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DeviceState } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";
import { MuteIcon, VolumeIcon } from "../icons";
import {
  errorMessage,
  errorOutcome,
  optimisticVolume,
  volumeSetCommand,
  volumeStepCommand,
  volumeView,
  type VolumePayload,
  type VolumeView,
} from "./logic";
import { sendCommand } from "./state";

/** The level to show (optimistic while commands are in flight) and how to change it. */
export function useTvVolume(deviceId: string, s: DeviceState | null) {
  const qc = useQueryClient();
  const reported = volumeView(s);
  const [optimistic, setOptimistic] = useState<VolumeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(0);
  const level = optimistic ?? reported;

  const send = (p: VolumePayload) => {
    if (!level) return;
    setOptimistic(optimisticVolume(level, p));
    setError(null);
    inflight.current += 1;
    void sendCommand(qc, deviceId, "playback.set_volume", p)
      .then((ack) => {
        if (!ack.ok) setError(ack.error ?? "failed");
      })
      .catch((e: unknown) => {
        const o = errorOutcome(e);
        setError(o.kind === "error" ? o.code : "failed");
      })
      .finally(() => {
        inflight.current -= 1;
        // The last answer is in: show what the TV reports.
        if (inflight.current === 0) setOptimistic(null);
      });
  };
  return { level, send, error };
}

const pct = (v: number) => Math.round(v * 100);

/** The full row on /remote. */
export function VolumeRow({ deviceId, s }: { deviceId: string; s: DeviceState | null }) {
  const { t } = useI18n();
  const { level, send, error } = useTvVolume(deviceId, s);
  if (!level) return null;
  const n = pct(level.volume);
  const label = level.source === "system" ? t("remote.volume_tv") : t("remote.volume_app");
  return (
    <section className="space-y-2" data-testid="remote-volume" data-volume={n} data-muted={level.muted ? "1" : "0"} data-source={level.source} aria-label={label}>
      <div className="flex items-center justify-between text-sm">
        <h3 className="font-semibold text-text/85">{label}</h3>
        <span className="tabular-nums text-muted" data-testid="remote-volume-value">
          {level.muted ? t("remote.muted") : `${n} %`}
        </span>
      </div>
      <div className="flex items-center gap-2 sm:gap-3">
        <StepButton label={t("remote.volume_down")} onClick={() => send(volumeStepCommand(-1))} testId="remote-volume-down">
          −
        </StepButton>
        <input
          type="range"
          min={0}
          max={100}
          step={10}
          value={level.muted ? 0 : n}
          aria-label={label}
          aria-valuetext={level.muted ? t("remote.muted") : t("remote.volume_level", { n })}
          onChange={(e) => send(volumeSetCommand(Number(e.target.value) / 100))}
          data-testid="remote-volume-bar"
          className={`h-12 min-w-0 flex-1 cursor-pointer accent-accent ${level.muted ? "opacity-50" : ""}`}
        />
        <StepButton label={t("remote.volume_up")} onClick={() => send(volumeStepCommand(1))} testId="remote-volume-up">
          +
        </StepButton>
        <button
          type="button"
          aria-pressed={level.muted}
          aria-label={level.muted ? t("remote.unmute") : t("remote.mute")}
          title={level.muted ? t("remote.unmute") : t("remote.mute")}
          onClick={() => send({ muted: !level.muted })}
          data-testid="remote-volume-mute"
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-xl transition ${
            level.muted ? "bg-accent text-on-accent hover:bg-accent-strong" : "bg-surface-2 hover:bg-border"
          }`}
        >
          {level.muted ? <MuteIcon /> : <VolumeIcon />}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(error, t)}
        </p>
      )}
    </section>
  );
}

function StepButton({ label, onClick, testId, children }: { label: string; onClick: () => void; testId: string; children: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      data-testid={testId}
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-surface-2 text-2xl font-bold leading-none transition hover:bg-border"
    >
      {children}
    </button>
  );
}

/** «Тише» / «Громче» for the compact «Сейчас на ТВ» bar. */
export function VolumeStepButtons({ deviceId, s }: { deviceId: string; s: DeviceState | null }) {
  const { t } = useI18n();
  const { level, send } = useTvVolume(deviceId, s);
  if (!level) return null;
  const cls = "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface text-xl font-bold leading-none transition hover:bg-border";
  return (
    <>
      <button type="button" aria-label={t("remote.volume_down")} title={t("remote.volume_down")} onClick={() => send(volumeStepCommand(-1))} className={cls} data-testid="bar-volume-down">
        −
      </button>
      <button type="button" aria-label={t("remote.volume_up")} title={t("remote.volume_up")} onClick={() => send(volumeStepCommand(1))} className={cls} data-testid="bar-volume-up">
        +
      </button>
    </>
  );
}

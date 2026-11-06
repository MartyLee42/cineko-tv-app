// «Включить на ТВ» for a live channel: the usual Send-to-TV flow (TV picker,
// busy_playing → confirm → force, result toast) with the iptv.play command.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useI18n } from "@martytv/ui";
import { usePickerDevices } from "../remote/AllDevicesToggle";
import { AlertIcon, CheckIcon, CloseIcon, RemoteIcon } from "../icons";
import { ackOutcome, chooseDevice, createFlowController, errorOutcome, IDLE, outcomeMessage, type Flow, type SendTarget } from "../remote/logic";

/** The flow's target: media_id carries the channel id (the flow is target-agnostic). */
interface ChannelTarget extends SendTarget {
  profile_id: string | undefined;
}
import { sendCommand, setLastUsedDevice, useDeviceStates, useLastUsedDevice } from "../remote/state";
import { BusyDialog, DevicePicker } from "../remote/SendToTv";
import { useActiveProfile } from "../watch/ActiveProfile";

interface Ctx {
  flow: Flow;
  /** Sends the channel to a TV (asks which one when several are online). */
  send: (channelId: string) => void;
}

const SendCtx = createContext<Ctx | null>(null);

export function useSendChannel() {
  const v = useContext(SendCtx);
  if (!v) throw new Error("useSendChannel must be used inside SendChannelProvider");
  return v;
}

export function SendChannelProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data: devices } = usePickerDevices();
  const states = useDeviceStates(devices);
  const lastUsed = useLastUsedDevice();
  const { profileId } = useActiveProfile();
  const [flow, setFlow] = useState<Flow>(IDLE);

  const [dispatch] = useState(() =>
    createFlowController(setFlow, (s) => {
      setLastUsedDevice(s.deviceId);
      const pid = (s.target as ChannelTarget).profile_id;
      return sendCommand(qc, s.deviceId, "iptv.play", {
        channel_id: s.target.media_id,
        ...(pid && { profile_id: pid }),
        ...(s.force && { force: true }),
      }).then(ackOutcome, errorOutcome);
    }),
  );

  const live = useMemo(() => (devices ?? []).map((d) => ({ ...d, online: states[d.id]?.online ?? d.online })), [devices, states]);
  const ctx = useMemo<Ctx>(
    () => ({
      flow,
      send: (channelId) => {
        const target: ChannelTarget = { media_id: channelId, profile_id: profileId };
        dispatch({ type: "request", target, choice: chooseDevice(live, lastUsed) });
      },
    }),
    [flow, dispatch, live, lastUsed, profileId],
  );
  const cancel = useCallback(() => dispatch({ type: "cancel" }), [dispatch]);
  const dismiss = useCallback(() => dispatch({ type: "dismiss" }), [dispatch]);
  const nameOf = (id: string | null) => live.find((d) => d.id === id)?.name ?? "TV";

  return (
    <SendCtx.Provider value={ctx}>
      {children}
      {flow.step === "picking" && (
        <DevicePicker devices={live} states={states} preferred={flow.preferred ?? lastUsed} onPick={(id) => dispatch({ type: "pick", deviceId: id })} onClose={cancel} />
      )}
      {flow.step === "confirm" && (
        <BusyDialog tv={nameOf(flow.deviceId)} state={states[flow.deviceId]} onConfirm={() => dispatch({ type: "confirm" })} onCancel={cancel} play />
      )}
      {flow.step === "done" && <Toast flow={flow} tv={nameOf(flow.deviceId)} onDismiss={dismiss} />}
    </SendCtx.Provider>
  );
}

function Toast({ flow, tv, onDismiss }: { flow: Extract<Flow, { step: "done" }>; tv: string; onDismiss: () => void }) {
  const { t } = useI18n();
  const ok = flow.outcome.kind === "sent" || flow.outcome.kind === "queued";
  useEffect(() => {
    const timer = setTimeout(onDismiss, ok ? 5000 : 8000);
    return () => clearTimeout(timer);
  }, [onDismiss, ok]);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-[60] flex justify-center px-3 md:bottom-6">
      <div
        role={ok ? "status" : "alert"}
        data-testid="send-result"
        data-outcome={flow.outcome.kind === "error" ? flow.outcome.code : flow.outcome.kind}
        className={`pointer-events-auto flex min-h-[64px] w-full max-w-md items-center gap-3 rounded-2xl border bg-surface/95 py-2 pl-3.5 pr-2 shadow-2xl shadow-black/50 backdrop-blur ${ok ? "border-ok/30" : "border-danger/40"}`}
      >
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-lg ${ok ? "bg-ok/15 text-ok" : "bg-danger/15 text-danger"}`}>
          {ok ? <CheckIcon /> : <AlertIcon />}
        </span>
        <p className="min-w-0 flex-1 py-1.5 text-sm font-medium">{outcomeMessage(flow.outcome, tv, t)}</p>
        {ok && flow.deviceId && (
          <Link to={`/remote/${flow.deviceId}`} className="flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-accent hover:bg-surface-2">
            <RemoteIcon />
            {t("remote.remote")}
          </Link>
        )}
        <button type="button" onClick={onDismiss} aria-label={t("common.close")} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted hover:text-text">
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

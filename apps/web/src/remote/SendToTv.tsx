import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Device } from "@martytv/contracts";
import { Spinner, StatusDot, useI18n } from "@martytv/ui";
import { AllDevicesToggle, isForeign, usePickerDevices } from "./AllDevicesToggle";
import { timeAgo } from "../components";
import { AlertIcon, CastIcon, CheckIcon, CloseIcon, RemoteIcon } from "../icons";
import {
  ackOutcome,
  chooseDevice,
  createFlowController,
  errorOutcome,
  IDLE,
  orderDevices,
  outcomeMessage,
  sameTarget,
  screenKey,
  type Flow,
  type SendTarget,
} from "./logic";
import { sendCommand, setLastUsedDevice, useDeviceStates, useLastUsedDevice, type LiveState } from "./state";
import { useScrollLock } from "../scrollLock";

interface SendCtx {
  flow: Flow;
  request: (target: SendTarget) => void;
}

const Ctx = createContext<SendCtx | null>(null);

/** Owns the Send-to-TV flow for one page: picker, busy confirmation and result toast. */
export function SendToTvProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data: devices } = usePickerDevices();
  const states = useDeviceStates(devices);
  const lastUsed = useLastUsedDevice();
  const [flow, setFlow] = useState<Flow>(IDLE);

  // Created once: qc and setFlow are stable.
  const [dispatch] = useState(() =>
    createFlowController(setFlow, (s) => {
      setLastUsedDevice(s.deviceId);
      const { media_id, season_number, episode_number } = s.target;
      // A fresh command id per send (the forced resend too); RealtimeClient
      // reuses it for its own retry so the TV never opens it twice.
      return sendCommand(qc, s.deviceId, "media.open", {
        media_id,
        ...(season_number != null && { season_number }),
        ...(episode_number != null && { episode_number }),
        ...(s.force && { force: true }),
      }).then(ackOutcome, errorOutcome);
    }),
  );

  // Merge live online flags (presence events) into the list.
  const live = useMemo(
    () => (devices ?? []).map((d) => ({ ...d, online: states[d.id]?.online ?? d.online })),
    [devices, states],
  );

  const ctx = useMemo<SendCtx>(
    () => ({
      flow,
      request: (target) => dispatch({ type: "request", target, choice: chooseDevice(live, lastUsed) }),
    }),
    [flow, dispatch, live, lastUsed],
  );

  const pick = useCallback((id: string) => dispatch({ type: "pick", deviceId: id }), [dispatch]);
  const cancel = useCallback(() => dispatch({ type: "cancel" }), [dispatch]);
  const confirm = useCallback(() => dispatch({ type: "confirm" }), [dispatch]);
  const dismiss = useCallback(() => dispatch({ type: "dismiss" }), [dispatch]);
  const nameOf = (id: string | null) => live.find((d) => d.id === id)?.name ?? "TV";

  return (
    <Ctx.Provider value={ctx}>
      {children}
      {flow.step === "picking" && (
        <DevicePicker
          devices={live}
          states={states}
          preferred={flow.preferred ?? lastUsed}
          onPick={pick}
          onClose={cancel}
        />
      )}
      {flow.step === "confirm" && (
        <BusyDialog
          tv={nameOf(flow.deviceId)}
          state={states[flow.deviceId]}
          onConfirm={confirm}
          onCancel={cancel}
        />
      )}
      {flow.step === "done" && (
        <ResultToast flow={flow} tv={nameOf(flow.deviceId)} onDismiss={dismiss} />
      )}
    </Ctx.Provider>
  );
}

export function useSendToTv() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSendToTv must be used inside SendToTvProvider");
  return v;
}

/** Prominent hero button. */
export function SendToTvButton({
  target,
  className = "",
  secondary = false,
}: {
  target: SendTarget;
  className?: string;
  /** Quieter style when "Play on TV" is the primary action. */
  secondary?: boolean;
}) {
  const { t } = useI18n();
  const { flow, request } = useSendToTv();
  const pending = flow.step === "sending" && sameTarget(flow.target, target);
  return (
    <button
      type="button"
      onClick={() => request(target)}
      disabled={flow.step === "sending"}
      data-testid="send-to-tv"
      className={`inline-flex min-h-[48px] items-center justify-center gap-2.5 whitespace-nowrap rounded-xl font-semibold transition disabled:opacity-60 ${
        secondary
          ? "px-4 sm:px-5 border border-border bg-surface/70 text-text backdrop-blur hover:border-accent"
          : "px-6 bg-accent text-on-accent shadow-lg shadow-black/30 hover:bg-accent-strong"
      } ${className}`}
    >
      {pending ? <Spinner size={20} /> : <CastIcon className="text-[22px]" />}
      {pending ? t("remote.sending") : secondary ? t("remote.open_on_tv") : t("remote.send_to_tv")}
    </button>
  );
}

// ---------------------------------------------------------------- overlays

/** Bottom sheet on phones, centered dialog on wider screens. Escape / backdrop close it. */
export function Sheet({
  title,
  onClose,
  children,
  role = "dialog",
  wide = false,
  subtitle,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  role?: "dialog" | "alertdialog";
  /** Wider dialog on desktop (release lists). */
  wide?: boolean;
  subtitle?: ReactNode;
  testId?: string;
}) {
  const { t } = useI18n();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useScrollLock();
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = panel.current;
    (el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>("button:not([disabled])"))?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, []);

  // Portalled: a transformed or z-indexed ancestor would otherwise trap it under
  // the bottom nav and the now-on-TV bar, and centre it on that ancestor.
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] md:p-6">
      <div className="absolute inset-0 touch-none bg-black/60 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role={role}
        aria-modal
        aria-label={title}
        data-testid={testId}
        className={`relative max-h-full w-full max-w-md overflow-y-auto overscroll-contain rounded-3xl border border-border bg-surface px-4 pb-4 pt-2 shadow-2xl shadow-black/60 md:rounded-2xl md:pb-5 md:pt-4 ${
          wide ? "md:max-w-2xl md:px-5" : "md:max-w-md"
        }`}
      >
        <div className="mb-3 flex items-start gap-2">
          <div className="min-w-0 flex-1 pt-2">
            <h2 className="text-lg font-bold leading-tight">{title}</h2>
            {subtitle && <div className="mt-0.5 text-sm text-muted">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="-mr-2 flex h-11 w-11 items-center justify-center rounded-full text-xl text-muted hover:text-text"
          >
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** One-line description of what a TV is doing right now. */
export function useStateLine() {
  const { t, locale } = useI18n();
  return (d: Device, live: LiveState | undefined) => {
    const online = live?.online ?? d.online;
    if (!online) return d.last_seen_at ? t("devices.last_seen", { when: timeAgo(d.last_seen_at, locale) }) : t("common.offline");
    const s = live?.state;
    if (!s) return t("common.online");
    const what = s.live ? `${t("iptv.title")} · ${s.live.name}` : (s.playback?.title ?? (s.screen === "details" && s.title ? s.title : t(screenKey(s.screen))));
    return [s.profile_name, what].filter(Boolean).join(" · ");
  };
}

export function DevicePicker({
  devices,
  states,
  preferred,
  onPick,
  onClose,
}: {
  devices: Device[];
  states: Record<string, LiveState>;
  preferred: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const line = useStateLine();
  const ordered = orderDevices(devices.filter((d) => !isForeign(d)), preferred);
  const anyOnline = devices.some((d) => d.online);

  return (
    <Sheet title={t("remote.choose_tv")} onClose={onClose}>
      {!devices.length ? (
        <div className="space-y-4 py-2 text-center" data-testid="no-tvs">
          <p className="text-muted">{t("remote.no_tvs")}</p>
          <Link
            to="/pair"
            className="inline-flex min-h-[44px] items-center rounded-xl bg-accent px-5 font-semibold text-on-accent hover:bg-accent-strong"
          >
            {t("home.pair_cta")}
          </Link>
          <AllDevicesToggle devices={devices} onPick={onPick} />
        </div>
      ) : (
        <>
          {!anyOnline && (
            <div className="mb-3 flex gap-3 rounded-xl bg-surface-2 px-3.5 py-3 text-sm">
              <AlertIcon className="mt-0.5 shrink-0 text-lg text-muted" />
              <div>
                <p className="font-semibold">{t("remote.no_online_tvs")}</p>
                <p className="mt-0.5 text-muted">{t("remote.offline_hint")}</p>
              </div>
            </div>
          )}
          <ul className="space-y-2" data-testid="tv-picker">
            {ordered.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  disabled={!d.online}
                  onClick={() => onPick(d.id)}
                  {...(d.id === preferred && d.online ? { "data-autofocus": true } : {})}
                  className="flex min-h-[60px] w-full items-center gap-3 rounded-2xl border border-border bg-bg/40 px-3.5 py-2.5 text-left transition hover:border-accent focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-xl text-text/80">
                    <CastIcon />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <StatusDot online={d.online} />
                      <span className="truncate font-semibold">{d.name}</span>
                      {d.id === preferred && d.online && (
                        <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent">
                          {t("remote.last_used")}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-sm text-muted">{line(d, states[d.id])}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <AllDevicesToggle devices={devices} onPick={onPick} />
        </>
      )}
    </Sheet>
  );
}

export function BusyDialog({
  tv,
  state,
  onConfirm,
  onCancel,
  play = false,
}: {
  tv: string;
  state: LiveState | undefined;
  onConfirm: () => void;
  onCancel: () => void;
  /** The new request starts playback (vs. opening a title page). */
  play?: boolean;
}) {
  const { t } = useI18n();
  const p = state?.state?.playback;
  const title = [p?.title ?? state?.state?.title, p?.episode_label].filter(Boolean).join(" · ") || "…";
  return (
    <Sheet title={t("remote.busy_title", { tv })} onClose={onCancel} role="alertdialog">
      <div data-testid="busy-dialog">
        <p className="text-text/85">{t(play ? "player.busy_body" : "remote.busy_body", { title })}</p>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            type="button"
            data-autofocus
            onClick={onCancel}
            className="min-h-[48px] rounded-xl bg-surface-2 font-semibold hover:bg-border"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="min-h-[48px] rounded-xl bg-danger font-semibold text-bg hover:bg-danger/85"
          >
            {t("remote.interrupt")}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function ResultToast({
  flow,
  tv,
  onDismiss,
}: {
  flow: Extract<Flow, { step: "done" }>;
  tv: string;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const ok = flow.outcome.kind === "sent" || flow.outcome.kind === "queued";
  useEffect(() => {
    const timer = setTimeout(onDismiss, ok ? 5000 : 8000);
    return () => clearTimeout(timer);
  }, [onDismiss, ok]);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-30 flex justify-center px-3 md:bottom-6">
      <div
        role={ok ? "status" : "alert"}
        data-testid="send-result"
        data-outcome={flow.outcome.kind === "error" ? flow.outcome.code : flow.outcome.kind}
        className={`pointer-events-auto flex min-h-[72px] w-full max-w-md items-center gap-3 rounded-2xl border bg-surface/95 py-2 pl-3.5 pr-2 shadow-2xl shadow-black/50 backdrop-blur ${
          ok ? "border-ok/30" : "border-danger/40"
        }`}
      >
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-lg ${ok ? "bg-ok/15 text-ok" : "bg-danger/15 text-danger"}`}
        >
          {ok ? <CheckIcon /> : <AlertIcon />}
        </span>
        <p className="min-w-0 flex-1 py-1.5 text-sm font-medium">{outcomeMessage(flow.outcome, tv, t)}</p>
        {ok && flow.deviceId && (
          <Link
            to={`/remote/${flow.deviceId}`}
            className="flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-accent hover:bg-surface-2"
          >
            <RemoteIcon />
            {t("remote.remote")}
          </Link>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("common.close")}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted hover:text-text"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

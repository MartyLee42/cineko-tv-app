// The title page's play button. Pressing it asks where to watch — this
// device or a TV (the one showing the title first, the last choice focused so
// Enter repeats it). With no TV at all it plays here straight away. The ▾ half
// opens the same menu, which also holds the rarer ways to watch: online
// sources, the release list, download to this device, «open on TV».
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { MediaDetail } from "@martytv/contracts";
import { Spinner, StatusDot, useI18n } from "@martytv/ui";
import { CastIcon, ChevronRight, DeviceIcon, ListIcon, PlayIcon, RestartIcon } from "../icons";
import { readWatchWhere } from "../player/session";
import { isForeign, useIsSuperAdmin } from "../remote/AllDevicesToggle";
import { useSendToTv } from "../remote/SendToTv";
import { SaveToDeviceButton, type SaveTarget } from "../offline/ui";
import { isBusy } from "./flow";
import { OnlinePicker, StreamIcon, useHasOnline } from "./OnlineWatch";
import { usePlayOnTv, useWatchHere, type PlayTarget } from "./PlayOnTv";
import { orderChooserTvs, preselectTarget, skipChooser, type ChooserKey } from "./chooser";
import { useWebInstantPlay } from "./instantPlay";

const PHONE = "(max-width: 639px)";

function usePhone(): boolean {
  const mq = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(PHONE) : null);
  const [on, setOn] = useState(() => mq()?.matches ?? false);
  useEffect(() => {
    const m = mq();
    if (!m) return;
    const f = () => setOn(m.matches);
    m.addEventListener?.("change", f);
    return () => m.removeEventListener?.("change", f);
  }, []);
  return on;
}

export interface PlayChooserProps {
  m: MediaDetail;
  /** What plays (TV and here): the resume position when there is one. */
  target: PlayTarget;
  label: string;
  testId?: string;
  /** Resuming: the menu offers «From 32:36 / From the start». */
  resumeTime?: string;
  /** Movie: «Choose a release» and «Download to this device». */
  releases?: boolean;
  save?: SaveTarget;
  className?: string;
}

export function PlayChooser({ m, target, label, testId = "play-on-tv", resumeTime, releases, save, className = "" }: PlayChooserProps) {
  const { t } = useI18n();
  const { flow, tvs, states, lastUsed } = usePlayOnTv();
  const watchHere = useWatchHere();
  const superAdmin = useIsSuperAdmin();
  const [open, setOpen] = useState(false);
  const [online, setOnline] = useState(false);
  const group = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const busy = isBusy(flow);
  const mine = busy && "req" in flow && flow.req.media_id === target.media_id && flow.req.episode_id === target.episode_id;
  const own = tvs?.filter((d) => !isForeign(d));
  const { has: hasOnline, season } = useHasOnline(m);
  // «Мгновенный старт»: only when Play plays here (no TV to choose, or «здесь» last time).
  useWebInstantPlay(target, skipChooser(own, superAdmin || !!tvs?.some(isForeign)) || readWatchWhere() === "here");

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  const main = () => {
    if (skipChooser(own, superAdmin || !!tvs?.some(isForeign))) watchHere(target);
    else setOpen((o) => !o);
  };

  return (
    <>
      <div ref={group} className={`flex items-stretch ${className}`} data-testid="play-chooser">
        <button
          ref={trigger}
          type="button"
          onClick={main}
          disabled={busy}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid={testId}
          className="inline-flex min-h-[52px] min-w-0 flex-1 items-center justify-center gap-2 rounded-l-xl bg-accent py-1.5 pl-4 pr-3 text-base font-bold leading-tight text-on-accent sm:gap-2.5 sm:pl-6 sm:pr-5 sm:text-lg shadow-lg shadow-black/30 transition hover:bg-accent-strong disabled:opacity-60 sm:flex-none"
        >
          {mine ? <Spinner size={20} /> : <PlayIcon className="shrink-0 text-[22px]" />}
          <span className="min-w-0 text-center">{label}</span>
        </button>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t("titleactions.more")}
          title={t("titleactions.more")}
          data-testid="play-more"
          className="ml-px inline-flex min-h-[52px] w-12 shrink-0 items-center justify-center rounded-r-xl bg-accent text-xl text-on-accent shadow-lg shadow-black/30 transition hover:bg-accent-strong"
        >
          <ChevronRight className={`transition-transform ${open ? "-rotate-90" : "rotate-90"}`} />
        </button>
      </div>
      {open && (
        <ChooserPanel
          anchor={group}
          label={label}
          onClose={close}
          target={target}
          resumeTime={resumeTime}
          tvs={orderChooserTvs(
            (own ?? []).map((d) => {
              const s = states[d.id]?.state;
              return { ...d, playing: (s?.playback?.media_id ?? s?.media_id) === m.id };
            }),
            lastUsed,
          )}
          lastUsed={lastUsed}
          otherTv={superAdmin || !!tvs?.some(isForeign)}
          hasOnline={hasOnline}
          onOnline={() => setOnline(true)}
          releases={releases}
          save={save}
        />
      )}
      {online && <OnlinePicker m={m} initialSeason={season} onClose={() => setOnline(false)} />}
    </>
  );
}

function ChooserPanel({
  anchor,
  label,
  onClose,
  target,
  resumeTime,
  tvs,
  lastUsed,
  otherTv,
  hasOnline,
  onOnline,
  releases,
  save,
}: {
  anchor: RefObject<HTMLDivElement | null>;
  label: string;
  onClose: (refocus?: boolean) => void;
  target: PlayTarget;
  resumeTime?: string;
  tvs: { id: string; name: string; online: boolean; playing: boolean }[];
  lastUsed: string | null;
  otherTv: boolean;
  hasOnline: boolean;
  onOnline: () => void;
  releases?: boolean;
  save?: SaveTarget;
}) {
  const { t } = useI18n();
  const { play, playOn, chooseRelease } = usePlayOnTv();
  const send = useSendToTv();
  const watchHere = useWatchHere();
  const phone = usePhone();
  const panel = useRef<HTMLDivElement>(null);
  const [fromStart, setFromStart] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean; max: number } | null>(null);
  // Focused on open: the last choice, so Enter repeats it.
  const [where] = useState(readWatchWhere);
  const [initial] = useState<ChooserKey>(() => preselectTarget(tvs, lastUsed, where));
  const remembered: ChooserKey | null = where === "here" ? "here" : where === "tv" && lastUsed ? `tv:${lastUsed}` : null;
  const last = (k: ChooserKey) => (k === remembered ? t("player.web.continue_last") : undefined);

  const req: PlayTarget = resumeTime && fromStart ? { ...target, position_seconds: 0 } : target;
  const plain: PlayTarget = { ...target, position_seconds: undefined };
  const pick = (fn: () => void) => () => {
    onClose();
    fn();
  };

  // Desktop: a popover under the button (portalled: the hero clips overflow); phones: a bottom sheet.
  useLayoutEffect(() => {
    if (phone) return;
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const w = Math.min(352, window.innerWidth - 32);
      const left = Math.max(16, Math.min(r.left, window.innerWidth - w - 16));
      const h = panel.current?.scrollHeight ?? 320;
      // Down when it fits, else up when it fits there, else the roomier side (it scrolls).
      const below = window.innerHeight - r.bottom - 24;
      const above = r.top - 24;
      const up = h > below && (h <= above || above > below);
      setPos({ left, top: up ? r.top - 8 : r.bottom + 8, up, max: Math.max(160, up ? r.top - 24 : below) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [phone, anchor]);

  // Once visible (the popover is hidden until placed): focus the last choice.
  const shown = phone || !!pos;
  useEffect(() => {
    if (!shown) return;
    const el = panel.current;
    (el?.querySelector<HTMLElement>(`[data-key="${initial}"]:not([disabled])`) ?? el?.querySelector<HTMLElement>("[data-key]:not([disabled])"))?.focus();
  }, [initial, shown]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node;
      if (panel.current?.contains(n) || anchor.current?.contains(n)) return;
      onClose();
    };
    const onEsc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose(true);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [onClose, anchor]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = [...(panel.current?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]") ?? [])];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]!.focus();
  };

  const body = (
    <div
      ref={panel}
      role="dialog"
      aria-label={t("titleactions.more")}
      data-testid="play-menu"
      onKeyDown={onKeyDown}
      style={phone ? undefined : pos ? { position: "fixed", left: pos.left, top: pos.top, maxHeight: pos.max, transform: pos.up ? "translateY(-100%)" : undefined } : { position: "fixed", visibility: "hidden" }}
      className={
        phone
          ? "relative max-h-[85vh] w-full overflow-y-auto overscroll-contain rounded-t-3xl border border-border bg-surface px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2 shadow-2xl shadow-black/60"
          : "z-50 max-h-[70vh] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-border bg-surface p-2 shadow-2xl shadow-black/50"
      }
    >
      {phone && (
        <>
          <div className="mx-auto mb-2 h-1.5 w-10 rounded-full bg-border" aria-hidden />
          <p className="truncate px-3 pb-1 pt-1 text-base font-bold">{label}</p>
        </>
      )}
      {resumeTime && (
        <div className="px-1 pb-2 pt-1" role="group" aria-label={t("titleactions.from")}>
          <div className="flex rounded-xl border border-border p-0.5">
            <Seg on={!fromStart} onClick={() => setFromStart(false)} testId="resume-from">
              <PlayIcon className="text-sm" />
              {t("titleactions.from_position", { time: resumeTime })}
            </Seg>
            <Seg on={fromStart} onClick={() => setFromStart(true)} testId="start-over">
              <RestartIcon className="text-sm" />
              {t("titleactions.from_start")}
            </Seg>
          </div>
        </div>
      )}
      <ul className="space-y-0.5" data-testid="play-targets">
        <li>
          <Item k="here" badge={last("here")} testId="watch-here" icon={<DeviceIcon />} onClick={pick(() => watchHere(req))}>
            {t("titleactions.here")}
          </Item>
        </li>
        {tvs.map((d) => (
          <li key={d.id}>
            <Item
              k={`tv:${d.id}`}
              badge={last(`tv:${d.id}`)}
              testId="play-tv"
              deviceId={d.id}
              icon={<CastIcon />}
              disabled={!d.online}
              hint={
                <span className="flex items-center gap-1.5">
                  <StatusDot online={d.online} />
                  {d.playing && d.online ? t("titleactions.tv_playing") : d.online ? t("titleactions.tv_online") : t("titleactions.tv_offline")}
                </span>
              }
              onClick={pick(() => playOn(req, d.id))}
            >
              {t("titleactions.on_tv", { tv: d.name })}
            </Item>
          </li>
        ))}
        {otherTv && (
          <li>
            <Item k="tv-other" testId="play-other-tv" icon={<CastIcon />} onClick={pick(() => play(req))}>
              {t("titleactions.other_tv")}
            </Item>
          </li>
        )}
      </ul>
      <p className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wider text-muted" aria-hidden>
        {t("titleactions.other_ways")}
      </p>
      <ul className="space-y-0.5" aria-label={t("titleactions.other_ways")}>
        {hasOnline && (
          <li>
            <Item k="online" testId="watch-online" icon={<StreamIcon />} hint={t("online.watch_hint")} onClick={pick(onOnline)}>
              {t("online.watch")}
            </Item>
          </li>
        )}
        {releases && (
          <li>
            <Item k="releases" testId="choose-release" icon={<ListIcon />} onClick={pick(() => chooseRelease(plain))}>
              {t("titleactions.choose_release")}
            </Item>
          </li>
        )}
        {save && (
          <li>
            <SaveToDeviceButton item target={save} />
          </li>
        )}
        <li>
          <Item
            k="send"
            testId="send-to-tv"
            icon={<CastIcon />}
            hint={t("titleactions.open_on_tv_hint")}
            disabled={send.flow.step === "sending"}
            onClick={pick(() => send.request({ media_id: target.media_id }))}
          >
            {t("remote.open_on_tv")}
          </Item>
        </li>
      </ul>
    </div>
  );

  return createPortal(
    phone ? (
      <div className="fixed inset-0 z-40 flex items-end">
        <div className="absolute inset-0 bg-black/60" onClick={() => onClose()} aria-hidden />
        {body}
      </div>
    ) : (
      body
    ),
    document.body,
  );
}

function Item({
  k,
  badge,
  icon,
  hint,
  children,
  onClick,
  disabled,
  testId,
  deviceId,
}: {
  k: string;
  /** «В прошлый раз». */
  badge?: string;
  icon: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  testId: string;
  deviceId?: string;
}) {
  return (
    <button
      type="button"
      data-key={k}
      data-testid={testId}
      data-device-id={deviceId}
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-[48px] w-full items-center gap-3 rounded-xl px-3 py-1.5 text-left transition hover:bg-surface-2 focus:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <span className="flex w-6 shrink-0 justify-center text-xl text-accent">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{children}</span>
        {hint && <span className="block truncate text-xs text-muted">{hint}</span>}
      </span>
      {badge && <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent-strong">{badge}</span>}
    </button>
  );
}

function Seg({ on, onClick, children, testId }: { on: boolean; onClick: () => void; children: ReactNode; testId: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      data-testid={testId}
      className={`flex min-h-[40px] flex-1 items-center justify-center gap-1.5 rounded-[10px] px-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        on ? "bg-accent text-on-accent" : "text-text/85 hover:bg-surface-2"
      }`}
    >
      {children}
    </button>
  );
}

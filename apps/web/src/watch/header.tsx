import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { Message } from "@martytv/contracts";
import { ProfileAvatar, useI18n } from "@martytv/ui";
import { realtime } from "../api";
import { timeAgo } from "../components";
import { BellIcon, CheckIcon, CloseIcon, GearIcon, ShieldIcon, TvIcon } from "../icons";
import { Sheet } from "../remote/SendToTv";
import { useActiveProfile } from "./ActiveProfile";
import { useInbox, useMarkRead } from "./queries";
import { ServerDownloadIcon } from "../downloads/ui";
import { InstallBanner, useStartInstall } from "../install/InstallUI";
import { cameFromTv, leaveToTvHost, openTvVersion } from "./fromTv";

/** Header avatar → menu: switch profile, settings, profiles, sign out. */
export function ProfileMenu({ userName, onLogout, isAdmin = false }: { userName: string; onLogout: () => void; isAdmin?: boolean }) {
  const { t } = useI18n();
  const { profile, profiles, switchTo } = useActiveProfile();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const install = useStartInstall();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item = "flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 text-left text-sm hover:bg-surface-2";
  return (
    <div ref={root} className="relative">
      {/* «Установить приложение»: one-time banner + the iOS steps sheet (portals). */}
      <InstallBanner />
      {install.steps}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("profile.menu", { name: profile?.name ?? userName })}
        data-testid="profile-menu-button"
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-[40px] items-center gap-2 rounded-full border border-border bg-surface py-1 pl-1 pr-1 text-sm hover:border-muted sm:pr-3"
      >
        {profile ? (
          <ProfileAvatar name={profile.name} color={profile.color} avatar={profile.avatar} size={30} className="!rounded-full" />
        ) : (
          <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-surface-2 font-semibold">
            {(userName[0] ?? "?").toUpperCase()}
          </span>
        )}
        <span className="hidden max-w-[8rem] truncate font-medium sm:inline">{profile?.name ?? userName}</span>
      </button>
      {open && (
        <div
          role="menu"
          data-testid="profile-menu"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-40 w-72 rounded-2xl border border-border bg-surface p-2 shadow-2xl shadow-black/30"
        >
          {profiles.length > 0 && (
            <>
              <p className="px-3 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-wider text-muted">{t("profile.watching_as")}</p>
              {profiles.map((p) => {
                const on = p.id === profile?.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    onClick={() => {
                      setOpen(false);
                      if (!on) switchTo(p);
                    }}
                    className={`${item} ${on ? "bg-surface-2 font-semibold" : ""}`}
                  >
                    <ProfileAvatar name={p.name} color={p.color} avatar={p.avatar} size={30} className="!rounded-full" />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    {p.has_pin && !on && <span aria-hidden>🔒</span>}
                    {on && <CheckIcon className="text-accent" />}
                  </button>
                );
              })}
              <div className="my-1.5 border-t border-border" />
            </>
          )}
          <Link role="menuitem" to="/profiles" onClick={() => setOpen(false)} className={item}>
            <span className="w-[30px] text-center text-muted">✎</span>
            {t("profiles.manage")}
          </Link>
          <Link role="menuitem" to="/devices" onClick={() => setOpen(false)} className={item} data-testid="menu-devices">
            <TvIcon className="w-[30px] text-lg text-muted" />
            {t("nav.devices")}
          </Link>
          <Link role="menuitem" to="/downloads" onClick={() => setOpen(false)} className={item} data-testid="menu-downloads">
            <ServerDownloadIcon className="w-[30px] text-lg text-muted" />
            {t("downloads.title")}
          </Link>
          <Link role="menuitem" to="/settings" onClick={() => setOpen(false)} className={item}>
            <GearIcon className="w-[30px] text-lg text-muted" />
            {t("settings.title")}
          </Link>
          {install.offer && (
            <button
              type="button"
              role="menuitem"
              data-testid="menu-install"
              onClick={() => {
                setOpen(false);
                install.start();
              }}
              className={item}
            >
              <span className="w-[30px] text-center text-lg text-muted" aria-hidden>
                ⤓
              </span>
              {t("install.action_long")}
            </button>
          )}
          {isAdmin && (
            <Link role="menuitem" to="/admin" onClick={() => setOpen(false)} className={item} data-testid="menu-admin">
              <ShieldIcon className="w-[30px] text-lg text-muted" />
              {t("nav.admin")}
            </Link>
          )}
          {cameFromTv() && (
            <>
              <div className="my-1.5 border-t border-border" />
              <button type="button" role="menuitem" data-testid="menu-tv-version" onClick={() => openTvVersion()} className={item}>
                <TvIcon className="w-[30px] text-lg text-muted" />
                {t("tablet.tv_version")}
              </button>
              <button type="button" role="menuitem" data-testid="menu-leave-msx" onClick={() => leaveToTvHost()} className={item}>
                <span className="w-[30px] text-center text-lg text-muted" aria-hidden>
                  ↩
                </span>
                {t("tablet.back_to_msx")}
              </button>
            </>
          )}
          <div className="my-1.5 border-t border-border" />
          <p className="truncate px-3 pt-1 text-xs text-muted">{userName}</p>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
            className={`${item} text-danger`}
          >
            {t("nav.logout")}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- inbox

export function InboxButton() {
  const { t } = useI18n();
  const inbox = useInbox();
  const [open, setOpen] = useState(false);
  const unread = inbox.data?.unread ?? 0;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={unread ? t("messages.unread", { n: unread }) : t("messages.title")}
        data-testid="inbox-button"
        className="relative flex h-10 w-10 items-center justify-center rounded-full text-xl text-muted hover:bg-surface-2 hover:text-text"
      >
        <BellIcon />
        {unread > 0 && (
          <span
            data-testid="inbox-badge"
            className="absolute right-0.5 top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[11px] font-bold leading-none text-white ring-2 ring-bg"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {/* Portal: the header's backdrop-filter would otherwise contain the fixed sheet. */}
      {open && createPortal(<InboxSheet onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function InboxSheet({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const inbox = useInbox();
  const mark = useMarkRead();
  const items = inbox.data?.items ?? [];
  return (
    <Sheet title={t("messages.title")} onClose={onClose} testId="inbox-sheet">
      {!items.length ? (
        <p className="py-8 text-center text-muted">{t("messages.empty")}</p>
      ) : (
        <ul className="-mx-1 max-h-[60vh] space-y-2 overflow-y-auto px-1" data-testid="inbox-list">
          {items.map((m) => (
            <li
              key={m.id}
              className={`rounded-xl border p-3 ${m.read_at ? "border-border bg-surface" : "border-accent/50 bg-accent/10"}`}
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{m.title}</p>
                  <p className="text-xs text-muted">
                    {t("messages.from", { name: m.from_name })} · {timeAgo(m.created_at, locale)}
                  </p>
                </div>
                {!m.read_at && (
                  <button
                    type="button"
                    onClick={() => mark.mutate(m.id)}
                    className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-accent hover:bg-accent/15"
                  >
                    {t("messages.mark_read")}
                  </button>
                )}
              </div>
              <p className="mt-1.5 whitespace-pre-line text-sm leading-relaxed">{m.body}</p>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

// Toast for live `message` events.
let toast: Message | null = null;
const toastListeners = new Set<() => void>();
function setToast(m: Message | null) {
  toast = m;
  toastListeners.forEach((l) => l());
}

/** Subscribes to realtime `message` events: refresh the inbox and pop a toast. */
export function useMessageEvents(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    return realtime.on((env) => {
      if (env.type !== "message") return;
      void qc.invalidateQueries({ queryKey: ["messages"] });
      const m = env.payload as Message | undefined;
      if (m?.id) setToast(m);
    });
  }, [qc, enabled]);
}

export function MessageToast() {
  const { t } = useI18n();
  const mark = useMarkRead();
  const m = useSyncExternalStore(
    (cb) => {
      toastListeners.add(cb);
      return () => toastListeners.delete(cb);
    },
    () => toast,
    () => null,
  );
  useEffect(() => {
    if (!m) return;
    const id = setTimeout(() => setToast(null), 12_000);
    return () => clearTimeout(id);
  }, [m]);
  if (!m) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-40 flex justify-center px-3">
      <div
        role="status"
        data-testid="message-toast"
        className="pointer-events-auto w-full max-w-md rounded-2xl border border-accent/40 bg-surface/95 p-3.5 shadow-2xl shadow-black/30 backdrop-blur"
      >
        <div className="flex items-start gap-3">
          <BellIcon className="mt-0.5 shrink-0 text-lg text-accent" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{m.title}</p>
            <p className="text-xs text-muted">{t("messages.from", { name: m.from_name })}</p>
            <p className="mt-1 line-clamp-4 whitespace-pre-line text-sm">{m.body}</p>
          </div>
          <button
            type="button"
            aria-label={t("messages.mark_read")}
            onClick={() => {
              mark.mutate(m.id);
              setToast(null);
            }}
            className="-mr-1 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
          >
            <CloseIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState, useSyncExternalStore } from "react";
import { unwrap, type Message } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";
import { api } from "../api";
import { playerKey } from "../player/keys";
import { claimKeys } from "../remote/keyOwner";
import { messageQueue } from "../watch/stores";

const BANNER_MS = 10_000;

/** Set while a compact banner is visible during playback (Down opens it). */
let bannerOpen: (() => void) | null = null;

/** The player's Down key: opens the message banner, if one is shown. */
export function openMessageBanner(): boolean {
  if (!bannerOpen) return false;
  bannerOpen();
  return true;
}

const subscribe = (cb: () => void) => messageQueue.subscribe(cb);
const getCurrent = () => messageQueue.current;
const getSize = () => messageQueue.size;

/**
 * Admin messages: a readable card over the catalog (OK marks it read, Back
 * closes it for now); during playback only a compact banner, which Down
 * opens (pausing the video) — otherwise the card waits until playback ends.
 */
export function MessageLayer({ playing, onPause }: { playing: boolean; onPause: () => void }) {
  const cur = useSyncExternalStore(subscribe, getCurrent);
  const size = useSyncExternalStore(subscribe, getSize);
  const [opened, setOpened] = useState<string | null>(null);
  const [bannerGone, setBannerGone] = useState<string | null>(null);
  const banner = !!cur && playing && opened !== cur.id && bannerGone !== cur.id;

  useEffect(() => {
    if (!banner || !cur) return;
    const id = cur.id;
    bannerOpen = () => {
      onPause();
      setOpened(id);
    };
    const timer = setTimeout(() => setBannerGone(id), BANNER_MS);
    return () => {
      bannerOpen = null;
      clearTimeout(timer);
    };
  }, [banner, cur, onPause]);

  if (!cur) return null;
  if (playing && opened !== cur.id) {
    return banner ? <Banner m={cur} /> : null;
  }
  return <MessageCard key={cur.id} m={cur} more={size - 1} />;
}

function Banner({ m }: { m: Message }) {
  const { t } = useI18n();
  return (
    <div data-testid="tv-message-banner" className="absolute right-12 top-12 z-40 flex max-w-[760px] items-center rounded-3xl bg-surface-2/95 px-8 py-5 shadow-2xl">
      <span className="mr-5 flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-accent text-3xl text-on-accent">✉</span>
      <span className="min-w-0">
        <span className="block text-xl text-accent">{t("messages.new")}</span>
        <span className="block truncate text-3xl font-semibold">{m.title}</span>
      </span>
      <span className="ml-6 shrink-0 rounded-xl bg-text/10 px-4 py-2 text-2xl">{t("tv.messages.read_hint")}</span>
    </div>
  );
}

function MessageCard({ m, more }: { m: Message; more: number }) {
  const { t } = useI18n();
  useEffect(() => {
    const c = claimKeys();
    const close = (read: boolean) => {
      if (read) void unwrap(api.POST("/messages/{id}/read", { params: { path: { id: m.id } } })).catch(() => undefined);
      messageQueue.dismiss(m.id);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!c.top) return;
      const k = playerKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (k === "ok") close(true);
      else if (k === "back") close(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      c.release();
    };
  }, [m.id]);
  return (
    <div data-testid="tv-message" className="absolute left-0 top-0 z-40 flex h-full w-full items-center justify-center bg-black/60">
      <div className="w-[1180px] rounded-[40px] bg-surface px-20 py-16 shadow-2xl">
        <p className="text-2xl font-semibold uppercase tracking-wider text-accent">{t("messages.new")}</p>
        <h1 className="mt-4 line-clamp-2 text-6xl font-bold leading-tight">{m.title}</h1>
        <p className="mt-8 line-clamp-[10] whitespace-pre-line text-3xl leading-snug">{m.body}</p>
        <div className="mt-12 flex items-center justify-between">
          <span className="text-2xl text-muted">{m.from_name ? t("messages.from", { name: m.from_name }) : ""}</span>
          <span className="flex items-center">
            {more > 0 && <span className="mr-8 text-2xl text-muted">{t("tv.messages.more", { n: more })}</span>}
            <span className="tv-focus is-focused rounded-2xl bg-accent px-14 py-5 text-3xl font-semibold text-on-accent">{t("tv.messages.ok")}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

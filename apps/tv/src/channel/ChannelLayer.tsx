// «Cineko TV» (lazy chunk): tunes in when mounted, drives the normal player
// through the programme and draws the channel's OSD over it. Unmounting
// (channelState.close) stops playback.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { pause as pauseNav, resume as resumeNav } from "@noriginmedia/norigin-spatial-navigation";
import { unwrap } from "@martytv/contracts";
import { imageUrl } from "@martytv/media-types";
import { Spinner, useI18n } from "@martytv/ui";
import { api } from "../api";
import { useCatalogConfig } from "../catalog/queries";
import { Img } from "../components/Img";
import { dismiss, track } from "../foryou/queries";
import { player } from "../player/controller";
import { fetchReleases, releaseQuery } from "../player/data";
import { useFlow } from "../player/flow";
import { episodeLabel } from "../player/format";
import { playerKey } from "../player/keys";
import type { PlayContext } from "../player/session";
import { claimKeys } from "../remote/keyOwner";
import { useCalmMotion } from "../design/skins";
import { ChannelLogo, ChannelMark } from "./ChannelLogo";
import { osdKey } from "./keys";
import { buildClock, clockTime, slotProgress, type ChannelItem, type Slot } from "./schedule";
import { ChannelSession, OSD_BUTTONS, type ChannelSnapshot, type OsdButton } from "./session";
import { channelState, type ChannelRequest } from "./state";
import "./channel.css";

/** A pick that fails to start is skipped after this long (the error is shown meanwhile). */
const SKIP_FAILED_MS = 2500;

export function playContext(it: ChannelItem, req: ChannelRequest): PlayContext {
  const m = it.media;
  return {
    media_id: m.id,
    kind: m.kind,
    title: m.title,
    poster_path: m.poster_path ?? null,
    backdrop_path: m.backdrop_path ?? null,
    season: it.episode?.season_number ?? null,
    episode: it.episode?.episode_number ?? null,
    episode_id: it.episode?.id ?? null,
    episode_name: it.episode?.name ?? null,
    profile_id: req.profile_id,
    lang: req.lang,
    player: null,
    app: null,
    start_at: it.resume_seconds > 0 ? it.resume_seconds : 0,
  };
}

function newSession(req: ChannelRequest): ChannelSession {
  return new ChannelSession({
    load: async (count, exclude) => {
      const query: { count: number; lang: "en" | "ru"; exclude?: string } = { count, lang: req.lang };
      if (exclude.length) query.exclude = exclude.join(",");
      const r = await unwrap(api.GET("/profiles/{id}/channel", { params: { path: { id: req.profile_id }, query } }));
      return r.items;
    },
    play: (it) => {
      const ctx = playContext(it, req);
      player.playBest(ctx, ctx.start_at ?? 0);
    },
    stop: () => {
      if (player.flow.phase !== "idle") player.close();
    },
    prefetch: (it) => void fetchReleases(releaseQuery(playContext(it, req))).catch(() => undefined),
    dismiss: (id) => dismiss(id, "channel"),
    played: (id) => {
      track(id, "impression", "channel");
      track(id, "play", "channel");
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  });
}

export function ChannelLayer({ req }: { req: ChannelRequest }) {
  const session = useMemo(() => newSession(req), [req]);
  const snap = useSyncExternalStore(session.subscribe, session.get);
  const flow = useFlow();

  // Tune in on mount; leave (stop playback) on unmount.
  useEffect(() => {
    void session.start();
    return () => {
      channelState.setHooks(null);
      session.leave();
    };
  }, [session]);

  // The player hands the channel its keys and the end of each title.
  useEffect(() => {
    channelState.setHooks({
      onKey: (k, ctx) => {
        const s = session.get();
        const a = osdKey(k, { osd: s.osd, panel: ctx.panel, skip: ctx.skip });
        switch (a) {
          case null:
            return false;
          case "next":
            session.next();
            break;
          case "prev":
            session.prev();
            break;
          case "guide":
            session.showGuide();
            break;
          case "hide":
            session.hideOsd();
            break;
          case "leave":
            channelState.close();
            break;
          case "focus_prev":
          case "focus_next":
            session.moveFocus(a === "focus_next" ? 1 : -1);
            break;
          case "press":
            press(session, session.focused(), ctx.openPanel);
            break;
        }
        return true;
      },
      onEnded: () => {
        session.ended();
        return true;
      },
      leave: () => channelState.close(),
    });
  }, [session]);

  // A pick that can't start is skipped; the player closing on its own (a
  // phone's «Стоп», Back on an error) ends the channel.
  const tunedIn = useRef(false);
  useEffect(() => {
    if (flow.phase === "preparing" || flow.phase === "playing") tunedIn.current = true;
    if (flow.phase === "playing" && player.started) session.started();
    if (flow.phase === "failed") {
      const id = setTimeout(() => session.failed(), SKIP_FAILED_MS);
      return () => clearTimeout(id);
    }
    if (flow.phase === "idle" && tunedIn.current && session.get().phase === "on") channelState.close();
    return undefined;
  }, [flow, session]);

  if (snap.phase !== "on") return <TuningScreen snap={snap} onRetry={() => void session.start()} />;
  return <Osd snap={snap} failed={flow.phase === "failed"} />;
}

function press(session: ChannelSession, b: OsdButton, openPanel: () => void) {
  switch (b) {
    case "next":
      return session.next();
    case "not_this":
      return session.notThis();
    case "tracks":
      session.hideOsd();
      return openPanel();
    case "leave":
      return channelState.close();
  }
}

// ---------------------------------------------------------------- tuning / empty / error

function TuningScreen({ snap, onRetry }: { snap: ChannelSnapshot; onRetry: () => void }) {
  const { t } = useI18n();
  const calm = useCalmMotion();
  const [focus, setFocus] = useState<"retry" | "leave">(snap.phase === "error" ? "retry" : "leave");
  const ref = useRef({ phase: snap.phase, focus, onRetry });
  useEffect(() => {
    ref.current = { phase: snap.phase, focus, onRetry };
  });
  // The catalog stays underneath while tuning: this screen owns the remote.
  useEffect(() => {
    pauseNav();
    const claim = claimKeys();
    const onKey = (e: KeyboardEvent) => {
      if (!claim.top) return;
      const k = playerKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopPropagation();
      const s = ref.current;
      if (k === "back" || k === "stop") return channelState.close();
      if (s.phase === "tuning") return;
      if ((k === "left" || k === "right") && s.phase === "error") return setFocus(k === "left" ? "retry" : "leave");
      if (k === "ok") return s.focus === "retry" && s.phase === "error" ? s.onRetry() : channelState.close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      claim.release();
      resumeNav();
    };
  }, []);
  return (
    <div data-testid="channel-tuning" data-phase={snap.phase} className={`cktv-tuning ${calm ? "cktv-calm" : ""} absolute left-0 top-0 z-40 flex h-full w-full flex-col items-center justify-center bg-bg`}>
      <div className="cktv-snow absolute left-0 top-0 h-full w-full" />
      <div className="relative flex flex-col items-center">
        <ChannelLogo size={120} />
        {snap.phase === "tuning" ? (
          <>
            <p className="mt-14 text-[44px] font-semibold text-text">{t("channel.tuning")}</p>
            <p className="mt-4 text-[30px] text-muted">{t("channel.tuning_hint")}</p>
            <span className="mt-12 inline-flex">
              <Spinner size={64} />
            </span>
          </>
        ) : (
          <>
            <p className="mt-14 max-w-[1200px] text-center text-[40px] leading-snug text-text">{snap.phase === "empty" ? t("channel.empty") : t("channel.error")}</p>
            <div className="mt-12 flex">
              {snap.phase === "error" && (
                <span className={`cktv-btn tv-focus mr-6 rounded-control px-10 py-5 text-[30px] font-semibold ${focus === "retry" ? "is-focused bg-accent text-on-accent" : "bg-surface-2 text-text"}`}>
                  {t("channel.retry")}
                </span>
              )}
              <span className={`cktv-btn tv-focus rounded-control px-10 py-5 text-[30px] font-semibold ${focus === "leave" || snap.phase === "empty" ? "is-focused bg-accent text-on-accent" : "bg-surface-2 text-text"}`}>
                {t("channel.leave")}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- OSD

/** Re-renders every second while `on`. */
function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [on]);
  return now;
}

function Osd({ snap, failed }: { snap: ChannelSnapshot; failed: boolean }) {
  const { t } = useI18n();
  const now = useTick(snap.osd !== null);
  const calm = useCalmMotion();
  if (snap.osd === null && !failed && !snap.waiting) return null;
  const started = player.started;
  const slots = buildClock(
    snap.items.map((i) => i.runtime_minutes),
    snap.index,
    now,
    { position: started ? player.position() : null, duration: started ? player.duration() : null, startedAt: snap.startedAt },
    snap.osd === "guide" ? 4 : 3,
  );
  return (
    <div data-testid="channel-osd" data-osd={snap.osd ?? "none"} className={`pointer-events-none absolute left-0 top-0 z-30 h-full w-full ${calm ? "cktv-calm" : ""}`}>
      {snap.osd !== null && (
        <>
          <div className="cktv-scrim-top absolute left-0 top-0 h-[220px] w-full" />
          <div className="absolute left-[96px] top-[60px]">
            <ChannelLogo size={64} live={t("channel.live")} />
          </div>
          <div className="absolute right-[96px] top-[70px] text-[40px] font-bold text-text">{clockTime(now)}</div>
        </>
      )}
      {(failed || snap.waiting) && (
        <div className="cktv-note absolute left-1/2 top-[180px] -translate-x-1/2 rounded-full bg-surface-2 px-10 py-4 text-[30px] text-text">
          {failed ? t("channel.skipped") : t("channel.waiting")}
        </div>
      )}
      {snap.osd === "strip" && <Strip snap={snap} slots={slots} now={now} />}
      {snap.osd === "guide" && <Guide snap={snap} slots={slots} now={now} focus={snap.focus} />}
    </div>
  );
}

function itemLine(it: ChannelItem, t: ReturnType<typeof useI18n>["t"]): string {
  if (it.episode) {
    const ep = episodeLabel(it.episode.season_number, it.episode.episode_number, it.episode.name);
    return [t("channel.continue"), ep].filter(Boolean).join(" · ");
  }
  return it.reason?.text ?? (it.media.year ? String(it.media.year) : "");
}

function NowBlock({ it, slot, now, big }: { it: ChannelItem; slot: Slot | undefined; now: number; big?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="min-w-0">
      <div className="flex items-center">
        <span className="cktv-now rounded-[8px] bg-accent px-3 py-1 text-[22px] font-bold uppercase tracking-wider text-on-accent">{t("channel.now")}</span>
        {slot && <span className="ml-4 text-[26px] text-muted">{t("channel.until", { time: clockTime(slot.end) })}</span>}
      </div>
      <h2 data-testid="channel-now-title" className={`mt-3 truncate font-bold leading-tight text-text ${big ? "text-[60px]" : "text-[52px]"}`}>
        {it.media.title}
      </h2>
      <p className="mt-2 truncate text-[28px] text-text/80">{itemLine(it, t)}</p>
      <div className="cktv-progress mt-5 h-[8px] w-full overflow-hidden rounded-full bg-text/15">
        <div className="cktv-progress-fill h-full w-full origin-left rounded-full bg-accent" style={{ transform: `scaleX(${slotProgress(slot, now)})` }} />
      </div>
    </div>
  );
}

function Strip({ snap, slots, now }: { snap: ChannelSnapshot; slots: Slot[]; now: number }) {
  const { t } = useI18n();
  const cur = snap.items[snap.index];
  if (!cur) return null;
  const later = slots.slice(1, 3);
  return (
    <div data-testid="channel-strip" className="absolute bottom-0 left-0 w-full">
      <div className="cktv-scrim-bottom absolute bottom-0 left-0 h-[600px] w-full" />
      <div className="relative flex items-end px-[96px] pb-[64px]">
        <div className="min-w-0 flex-1">
          <NowBlock it={cur} slot={slots[0]} now={now} />
          <div className="mt-7 flex">
            {later.map((s, i) => {
              const it = snap.items[s.index]!;
              return (
                <div key={s.index} className={`cktv-later min-w-0 flex-1 ${i > 0 ? "ml-12" : ""}`}>
                  <p className="text-[24px] font-semibold uppercase tracking-wider text-accent">
                    {t(i === 0 ? "channel.next_at" : "channel.then_at", { time: clockTime(s.start) })}
                  </p>
                  <p className="mt-1 truncate text-[32px] font-semibold text-text">{it.media.title}</p>
                </div>
              );
            })}
          </div>
          <p className="mt-6 text-[22px] text-muted">{t("channel.hint")}</p>
        </div>
      </div>
    </div>
  );
}

function Guide({ snap, slots, now, focus }: { snap: ChannelSnapshot; slots: Slot[]; now: number; focus: number }) {
  const { t } = useI18n();
  const cfg = useCatalogConfig();
  const cur = snap.items[snap.index];
  if (!cur) return null;
  const labels: Record<OsdButton, string> = {
    next: `▲ ${t("channel.btn.next")}`,
    not_this: t("channel.btn.not_this"),
    tracks: t("channel.btn.tracks"),
    leave: t("channel.btn.leave"),
  };
  return (
    <div data-testid="channel-guide" className="absolute bottom-0 left-0 w-full">
      <div className="cktv-scrim-bottom absolute bottom-0 left-0 h-[860px] w-full" />
      <div className="relative flex items-end px-[96px] pb-[56px]">
        <div className="cktv-poster mr-10 flex h-[330px] w-[220px] shrink-0 items-center justify-center overflow-hidden rounded-card bg-surface-2">
          {cur.media.poster_path ? (
            <Img src={imageUrl(cfg.data, cur.media.poster_path, "w342")} className="h-full w-full object-cover" />
          ) : (
            <ChannelMark size={110} className="text-text/40" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <NowBlock it={cur} slot={slots[0]} now={now} big />
          <div className="cktv-list tv-panel mt-7 rounded-card px-8 py-4">
            {slots.slice(1).map((s, i) => {
              const it = snap.items[s.index]!;
              return (
                <div key={s.index} className={`flex items-center py-3 ${i > 0 ? "border-t border-text/10" : ""}`}>
                  <span className="w-[120px] shrink-0 font-mono text-[30px] font-bold text-accent">{clockTime(s.start)}</span>
                  <span className="min-w-0 flex-1 truncate text-[30px] font-semibold text-text">{it.media.title}</span>
                  <span className="ml-6 shrink-0 truncate text-[24px] text-muted" style={{ maxWidth: 560 }}>
                    {itemLine(it, t)}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="mt-7 flex">
            {OSD_BUTTONS.map((b, i) => (
              <span
                key={b}
                data-testid={`channel-btn-${b}`}
                className={`cktv-btn tv-focus mr-5 rounded-control px-8 py-4 text-[28px] font-semibold ${i === focus ? "is-focused bg-accent text-on-accent" : "bg-surface-2 text-text"}`}
              >
                {labels[b]}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

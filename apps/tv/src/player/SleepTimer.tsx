// The player's sleep timer (see sleep.ts for the rules): state per playback
// session, the last-minute dim (overlay opacity + a lower volume), and the
// goodnight screen. PlayerLayer wires its keys, panel items and episode end.
import { useCallback, useEffect, useRef, useState } from "react";
import { Mascot, SovietEmblem, useConstructivism, useI18n } from "@martytv/ui";
import { dimming, dimOpacity, dimVolume, due, extendSleep, remainingMinutes, sleepAtEpisodeEnd, SLEEP_OFF, startSleep, type SleepChoice, type SleepState } from "./sleep";

export interface SleepTimer {
  state: SleepState;
  asleep: boolean;
  /** Overlay opacity now (0 = no dim). */
  dim: number;
  /** «Сон через 24 мин» / «Сон после этой серии», or null. */
  label: string | null;
  choose(c: SleepChoice): string;
  /** A remote key: true when the timer used it (woke up / extended). */
  onKey(): boolean;
  /** The episode ended: true = goodnight shown (no next-episode countdown). */
  atEpisodeEnd(): boolean;
}

export function useSleepTimer(video: HTMLVideoElement | null, pause: () => void, notify: (s: string) => void): SleepTimer {
  const { t } = useI18n();
  const [state, setState] = useState<SleepState>(SLEEP_OFF);
  const [asleep, setAsleep] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const baseVol = useRef<number | null>(null);

  // A time timer ticks once a second (the dim ramps with it).
  useEffect(() => {
    if (state.mode !== "time") return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state]);

  const restoreVolume = useCallback(() => {
    if (video && baseVol.current !== null) {
      try {
        video.volume = baseVol.current;
      } catch {
        /* engines that refuse volume writes */
      }
    }
    baseVol.current = null;
  }, [video]);

  const sleepNow = useCallback(() => {
    pause();
    restoreVolume();
    setState(SLEEP_OFF);
    setAsleep(true);
  }, [pause, restoreVolume]);

  // The dim lowers the volume a little; it fires at the end.
  useEffect(() => {
    if (due(state, now)) return sleepNow();
    if (!video) return;
    if (dimming(state, now)) {
      if (baseVol.current === null) baseVol.current = video.volume;
      try {
        video.volume = baseVol.current * dimVolume(state, now);
      } catch {
        /* ignore */
      }
    } else if (baseVol.current !== null) restoreVolume();
  }, [state, now, video, sleepNow, restoreVolume]);

  // The player closing (unmount) puts the volume back.
  useEffect(() => () => restoreVolume(), [restoreVolume]);

  const st = useRef({ state, asleep, now });
  st.current = { state, asleep, now };

  const onKey = useCallback(() => {
    const { state, asleep } = st.current;
    if (asleep) {
      setAsleep(false);
      return true;
    }
    const at = Date.now();
    if (dimming(state, at)) {
      restoreVolume();
      setState(extendSleep(state, at));
      notify(t("sleep.extended"));
      return true;
    }
    return false;
  }, [notify, restoreVolume, t]);

  const atEpisodeEnd = useCallback(() => {
    if (!sleepAtEpisodeEnd(st.current.state)) return false;
    setState(SLEEP_OFF);
    setAsleep(true);
    return true;
  }, []);

  const choose = useCallback(
    (c: SleepChoice) => {
      restoreVolume();
      const next = startSleep(c, Date.now());
      setState(next);
      if (next.mode === "off") return t("sleep.cancelled");
      return t("sleep.set", { what: c === "episode" ? t("sleep.episode") : t("sleep.minutes", { n: c }) });
    },
    [restoreVolume, t],
  );

  const mins = remainingMinutes(state, now);
  const label = state.mode === "episode" ? t("sleep.after_episode") : mins !== null ? t("sleep.in", { n: mins }) : null;
  return { state, asleep, dim: asleep ? 0 : dimOpacity(state, now), label, choose, onKey, atEpisodeEnd };
}

/** The last-minute dim and the goodnight screen (on top of the player). */
export function SleepOverlay({ timer }: { timer: SleepTimer }) {
  const { t } = useI18n();
  const cv = useConstructivism();
  if (timer.asleep) {
    return (
      <div data-testid="player-goodnight" className="fixed left-0 top-0 z-30 flex h-[1080px] w-[1920px] flex-col items-center justify-center" style={{ background: "rgba(0,0,0,.96)" }}>
        {cv ? <SovietEmblem size={160} /> : <Mascot size={180} mood="sleepy" animated />}
        <p className="mt-8 text-5xl font-semibold text-text/80">{t("sleep.goodnight")}</p>
        <p className="mt-4 text-2xl text-text/40">{t("sleep.wake_hint")}</p>
      </div>
    );
  }
  if (timer.dim <= 0) return null;
  return (
    <div
      data-testid="player-sleep-dim"
      className="pointer-events-none fixed left-0 top-0 z-30 h-[1080px] w-[1920px] bg-black"
      style={{ opacity: timer.dim, transition: "opacity 1s linear" }}
    />
  );
}

// This TV's background speed test (Settings → «Это устройство» →
// «Измерять скорость интернета в фоне»): measures the TV → server link
// (GET /speedtest) after start-up, every few hours and when the network
// seems to have changed — never while the player is open. Results join the
// playback samples in rateStore; the new estimate is re-reported so the
// server ranks releases for the current network.
import { useSyncExternalStore } from "react";
import { createSpeedtestAgent, lastSpeedText, latestSpeedtest, type SpeedtestResponse } from "@martytv/media-types";
import { api } from "../api";
import { storage } from "../platform";
import { player } from "../player/controller";
import { rateStore } from "../player/rebuffer";
import { devicePrefs } from "./devicePrefs";

const busy = () => player.flow.phase !== "idle";

export const speedtest = createSpeedtestAgent({
  kv: storage,
  busy,
  fetchBytes: async (bytes, signal) => {
    const { response } = await api.GET("/speedtest", { params: { query: { bytes } }, parseAs: "stream", signal });
    return response as SpeedtestResponse;
  },
  onResult: (bps) => {
    rateStore.add(bps, "speedtest");
    devicePrefs.noteThroughput(rateStore.get());
  },
});

let wired = false;

/** Starts the background schedule (once, after sign-in). */
export function startSpeedtest() {
  if (wired) return;
  wired = true;
  player.subscribe((kind) => {
    if (kind === "flow") speedtest.setBusy(busy());
  });
  speedtest.start();
}

/** «Скорость до сервера: 42 Мбит/с · 5 мин назад» / «Измеряю скорость…» (+ why background checks pause). */
export function speedtestLine(t: (k: string, v?: Record<string, string | number>) => string): string {
  if (speedtest.running()) return t("tvplay.net.running");
  const line = lastSpeedText(latestSpeedtest(rateStore.list()), Date.now(), t);
  const paused = speedtest.enabled() ? speedtest.paused() : null;
  return paused ? `${line} · ${t(`tvplay.net.${paused}`)}` : line;
}

/** React: re-renders on speed-test changes (running, setting, results). */
export function useSpeedtest(): number {
  return useSyncExternalStore(speedtest.subscribe, speedtest.version);
}

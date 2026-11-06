// This browser's background speed test (Settings → «Это устройство» →
// «Измерять скорость интернета в фоне»): measures the browser → server link
// (GET /speedtest) after start-up, every few hours and when the network
// changes (navigator.connection, `online`, back after a long time hidden) —
// never while the watch page or a release list is open, on mobile data or
// with Data Saver. Results join the playback samples; the new estimate is
// re-reported so releases are ranked for the current network.
import { useEffect, useSyncExternalStore } from "react";
import type { Schemas } from "@martytv/contracts";
import { createSpeedtestAgent, lastSpeedText, latestSpeedtest, type SpeedtestResponse } from "@martytv/media-types";
import { api, queryClient } from "../api";
import { readSampleList, recordSample, storage } from "./logic";
import { syncClient } from "./queries";

let busyCount = 0;

export const speedtest = createSpeedtestAgent({
  kv: {
    get: (k) => {
      try {
        return storage()?.getItem(k) ?? null;
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        storage()?.setItem(k, v);
      } catch {
        // private mode / quota
      }
    },
  },
  busy: () => busyCount > 0,
  fetchBytes: async (bytes, signal) => {
    const { response } = await api.GET("/speedtest", { params: { query: { bytes } }, parseAs: "stream", signal });
    return response as SpeedtestResponse;
  },
  onResult: (bps) => {
    recordSample(bps, storage(), "speedtest");
    const userId = queryClient.getQueryData<Schemas["Session"] | null>(["session"])?.user.id;
    if (!userId) return;
    void syncClient(queryClient, userId, { force: true }).then((rec) => {
      // Release lists ranked for this browser follow the new estimate.
      if (rec) void queryClient.invalidateQueries({ queryKey: ["releases"] });
    });
  },
});

/**
 * Marks playback / stream preparation as active while mounted (the watch
 * page, release lists): background tests wait, a running one is aborted.
 */
export function usePlaybackBusy(active = true): void {
  useEffect(() => {
    if (!active) return;
    busyCount++;
    speedtest.setBusy(true);
    return () => {
      busyCount = Math.max(0, busyCount - 1);
      speedtest.setBusy(busyCount > 0);
    };
  }, [active]);
}

/** «Скорость до сервера: 42 Мбит/с · 5 мин назад» / «Измеряю скорость…». */
export function speedtestLine(t: (k: string, v?: Record<string, string | number>) => string): string {
  if (speedtest.running()) return t("tvplay.net.running");
  return lastSpeedText(latestSpeedtest(readSampleList()), Date.now(), t);
}

/** React: re-renders on speed-test changes (running, setting, results). */
export function useSpeedtest(): number {
  return useSyncExternalStore(speedtest.subscribe, speedtest.version);
}

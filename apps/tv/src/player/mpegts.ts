// Plain MPEG-TS live channels (…/stream.ts) on engines whose <video> can't
// play video/mp2t (desktop browsers, some WebViews): mpegts.js transmuxes
// the endless TS into MSE. Loaded lazily, only for such channels.
import type { HlsHandle } from "./stream";

/** Plays an endless MPEG-TS URL through mpegts.js; `onFatal` once it gives up. */
export async function attachMpegts(video: HTMLVideoElement, url: string, onFatal: (kind: "network" | "decode") => void): Promise<HlsHandle> {
  const mpegts = (await import("mpegts.js")).default;
  if (!mpegts.isSupported()) throw new Error("mpegts.js: no MSE");
  const abs = new URL(url, window.location.href).href;
  const player = mpegts.createPlayer(
    { type: "mpegts", isLive: true, url: abs },
    { enableStashBuffer: false, liveBufferLatencyChasing: true, lazyLoad: false, autoCleanupSourceBuffer: true },
  );
  let done = false;
  player.on(mpegts.Events.ERROR, (type: string) => {
    if (done) return;
    done = true;
    onFatal(type === mpegts.ErrorTypes.NETWORK_ERROR ? "network" : "decode");
  });
  player.attachMediaElement(video);
  player.load();
  return {
    destroy: () => {
      done = true;
      try {
        player.unload();
        player.detachMediaElement();
        player.destroy();
      } catch {
        // already gone
      }
    },
  };
}

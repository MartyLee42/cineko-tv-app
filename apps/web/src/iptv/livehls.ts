// hls.js tuned for live channels (sliding playlists): start near the live
// edge, keep a short back buffer, expose the live edge for «В эфир».
import { loadHls } from "../player/hls";

export interface LiveHandle {
  /** Live edge (seconds) as hls.js sees it, or the seekable end. */
  liveEdge(): number | null;
  destroy(): void;
}

/** Native HLS (Safari, iOS) when hls.js / MSE isn't available. */
function nativeHandle(video: HTMLVideoElement, url: string, onFatal: () => void): LiveHandle {
  const fail = () => onFatal();
  video.addEventListener("error", fail);
  video.src = url;
  return {
    liveEdge: () => (video.seekable.length ? video.seekable.end(video.seekable.length - 1) : null),
    destroy: () => {
      video.removeEventListener("error", fail);
      video.removeAttribute("src");
      video.load();
    },
  };
}

export async function attachLive(video: HTMLVideoElement, url: string, onFatal: () => void): Promise<LiveHandle> {
  const Hls = await loadHls();
  if (!Hls.isSupported()) {
    if (video.canPlayType("application/vnd.apple.mpegurl")) return nativeHandle(video, url, onFatal);
    onFatal();
    return { liveEdge: () => null, destroy: () => {} };
  }
  const hls = new Hls({
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 10,
    backBufferLength: 60,
    maxBufferLength: 30,
    manifestLoadingMaxRetry: 3,
    levelLoadingMaxRetry: 4,
    fragLoadingMaxRetry: 4,
  });
  let recovered = false;
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
      recovered = true;
      hls.recoverMediaError();
      return;
    }
    onFatal();
  });
  hls.attachMedia(video);
  hls.loadSource(url);
  return {
    liveEdge: () => {
      const p = hls.liveSyncPosition;
      if (p != null && Number.isFinite(p)) return p;
      return video.seekable.length ? video.seekable.end(video.seekable.length - 1) : null;
    },
    destroy: () => hls.destroy(),
  };
}

/**
 * Plain MPEG-TS channels (…/stream.ts): mpegts.js transmuxes the endless TS
 * into MSE (browsers can't play video/mp2t in a video element); native src
 * where MSE is missing.
 */
export async function attachLiveTs(video: HTMLVideoElement, url: string, onFatal: () => void): Promise<LiveHandle> {
  const mpegts = (await import("mpegts.js")).default;
  if (!mpegts.isSupported()) return nativeHandle(video, url, onFatal);
  const player = mpegts.createPlayer(
    { type: "mpegts", isLive: true, url: new URL(url, window.location.href).href },
    { enableStashBuffer: false, liveBufferLatencyChasing: true, lazyLoad: false, autoCleanupSourceBuffer: true },
  );
  let done = false;
  player.on(mpegts.Events.ERROR, () => {
    if (done) return;
    done = true;
    onFatal();
  });
  player.attachMediaElement(video);
  player.load();
  return {
    liveEdge: () => (video.buffered.length ? video.buffered.end(video.buffered.length - 1) : null),
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

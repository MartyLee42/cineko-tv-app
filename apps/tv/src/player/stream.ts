// HLS online sources on TV engines. Samsung/LG/MSX engines play HLS natively
// in <video> (canPlayType says maybe/probably) — that path is preferred
// there. Android (TV boxes' WebView, MSX on Android) plays HLS through
// hls.js over MSE although canPlayType says "maybe": its native HLS is the
// system MediaPlayer, which got stuck re-fetching the same segments after a
// seek and blanked the picture. Engines without native HLS but with Media
// Source Extensions (e.g. a plain Chrome 53+ WebView) load hls.js too.
// The full build: online sources (Collaps) carry their audio as a separate
// EXT-X-MEDIA rendition, which the light build can't play (silent video).
// Without either, the source is reported as unplayable ("HLS").
import { hasMediaSource, hlsMode, isHlsSource, type HlsMode } from "@martytv/media-types";
import { watched } from "../chunkReload";

export interface HlsHandle {
  destroy(): void;
}

/** How this engine plays a source's stream_url ("native" for MP4/torrents); `android`: prefer hls.js (online sources through our proxy only — IPTV URLs may lack CORS). */
export function streamMode(
  src: { format?: string | null; mime_type?: string | null } | null,
  video: { canPlayType(t: string): string } | null,
  mse = hasMediaSource(),
  android = false,
): HlsMode {
  if (!src || !isHlsSource(src)) return "native";
  return hlsMode(video, mse, android);
}

/**
 * hls.js settings for TV engines: modest forward / back buffers and a byte
 * cap (weak Android boxes run out of memory with hls.js' 60 MB default), and
 * the first fragment loaded at the start position (not segment 0 followed by
 * a seek).
 */
export function hlsConfig(startAt: number) {
  return {
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    maxBufferSize: 30 * 1000 * 1000,
    backBufferLength: 30,
    enableWorker: true,
    startPosition: startAt > 0.5 ? startAt : -1,
  };
}

let loader: Promise<typeof import("hls.js").default> | null = null;

/** Plays `url` through hls.js from `startAt`; `onFatal` once nothing more can be done in place. */
export async function attachHlsJs(video: HTMLVideoElement, url: string, onFatal: (kind: "network" | "decode") => void, startAt = 0): Promise<HlsHandle> {
  // A failed download is fetched again next time (and may mean a newer release: chunkReload.ts).
  loader ??= watched(import("hls.js")).then(
    (m) => m.default,
    (e: unknown) => {
      loader = null;
      throw e;
    },
  );
  const Hls = await loader;
  const hls = new Hls(hlsConfig(startAt));
  let recovered = false;
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
      recovered = true;
      hls.recoverMediaError();
      return;
    }
    onFatal(data.type === Hls.ErrorTypes.NETWORK_ERROR ? "network" : "decode");
  });
  hls.attachMedia(video);
  hls.loadSource(url);
  return { destroy: () => hls.destroy() };
}

/** A URL that differs from the loaded one so the engine really reloads. */
export function reloadUrl(next: string, current: string | null, quality: number): string {
  if (next !== current) return next;
  return `${next}${next.includes("?") ? "&" : "?"}q=${quality}`;
}

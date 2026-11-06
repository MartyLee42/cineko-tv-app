// hls.js for HLS online sources where the browser has no native HLS (desktop
// Chrome/Firefox/Edge) and on Android, whose native HLS (the system
// MediaPlayer) seeks badly. Loaded on demand so the main bundle doesn't
// carry it. The full build: online sources (Collaps) carry their audio as a
// separate EXT-X-MEDIA rendition, which the light build can't play (silent
// video); subtitles still come as <track>s.
export interface HlsHandle {
  destroy(): void;
}

export type HlsFatal = "network" | "decode";

let loader: Promise<typeof import("hls.js").default> | null = null;

/** The hls.js class (one dynamic import per page). */
export function loadHls() {
  loader ??= import("hls.js").then((m) => m.default);
  return loader;
}

/** hls.js settings: the first fragment loaded at the start position (not segment 0 followed by a seek). */
export function hlsConfig(startAt: number) {
  return { backBufferLength: 90, maxBufferLength: 30, maxMaxBufferLength: 120, startPosition: startAt > 0.5 ? startAt : -1 };
}

/** Plays `url` in `video` through hls.js from `startAt`; `onFatal` on unrecoverable errors. */
export async function attachHls(video: HTMLVideoElement, url: string, onFatal: (kind: HlsFatal, status: number | null) => void, startAt = 0): Promise<HlsHandle> {
  const Hls = await loadHls();
  const hls = new Hls(hlsConfig(startAt));
  let mediaRecovered = false;
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
      // One decoder hiccup (common after a seek) is recoverable in place.
      mediaRecovered = true;
      hls.recoverMediaError();
      return;
    }
    const status = (data.response as { code?: number } | undefined)?.code ?? null;
    onFatal(data.type === Hls.ErrorTypes.NETWORK_ERROR ? "network" : "decode", status);
  });
  hls.attachMedia(video);
  hls.loadSource(url);
  return { destroy: () => hls.destroy() };
}

// Thin, feature-detected wrappers around browser media APIs that TypeScript's
// DOM types don't cover (WebKit fullscreen / PiP, audio tracks, decoded-bytes
// counters, orientation lock).
import type { AudioProbe } from "./logic";

type WebkitVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
  webkitAudioDecodedByteCount?: number;
  mozHasAudio?: boolean;
  audioTracks?: AudioTrackListLike;
};

export interface AudioTrackLike {
  id: string;
  label: string;
  language: string;
  enabled: boolean;
}

export interface AudioTrackListLike {
  readonly length: number;
  [index: number]: AudioTrackLike;
  addEventListener?: (type: string, fn: () => void) => void;
  removeEventListener?: (type: string, fn: () => void) => void;
}

type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

const w = (v: HTMLVideoElement) => v as WebkitVideo;

export function fullscreenElement(): Element | null {
  const d = document as FsDocument;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

/**
 * Fullscreen on the player container (custom controls stay visible); iPhone
 * Safari only allows it on the <video> itself (native controls then).
 */
export async function enterFullscreen(container: HTMLElement, video: HTMLVideoElement): Promise<boolean> {
  const el = container as FsElement;
  try {
    if (el.requestFullscreen) {
      await el.requestFullscreen({ navigationUI: "hide" });
      return true;
    }
    if (el.webkitRequestFullscreen) {
      await el.webkitRequestFullscreen();
      return true;
    }
  } catch {
    // fall through to the video element
  }
  const v = w(video);
  if (v.webkitEnterFullscreen) {
    try {
      v.webkitEnterFullscreen();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function exitFullscreen(): Promise<void> {
  const d = document as FsDocument;
  try {
    if (d.fullscreenElement && d.exitFullscreen) await d.exitFullscreen();
    else if (d.webkitFullscreenElement && d.webkitExitFullscreen) await d.webkitExitFullscreen();
  } catch {
    // already left
  }
}

export function canFullscreen(video: HTMLVideoElement | null): boolean {
  if (typeof document === "undefined") return false;
  const d = document as FsDocument & { webkitFullscreenEnabled?: boolean };
  return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled || (video && w(video).webkitEnterFullscreen));
}

/** Landscape while fullscreen on phones (where the API exists). */
export function lockLandscape() {
  const o = (screen as Screen & { orientation?: ScreenOrientation & { lock?: (o: string) => Promise<void> } }).orientation;
  try {
    void o?.lock?.("landscape")?.catch(() => undefined);
  } catch {
    // not supported (desktop, iOS)
  }
}

export function unlockOrientation() {
  try {
    screen.orientation?.unlock?.();
  } catch {
    // not supported
  }
}

export function canPip(video: HTMLVideoElement | null): boolean {
  if (!video || typeof document === "undefined") return false;
  if (document.pictureInPictureEnabled && !video.disablePictureInPicture) return true;
  return !!w(video).webkitSupportsPresentationMode?.("picture-in-picture");
}

export async function togglePip(video: HTMLVideoElement): Promise<void> {
  const v = w(video);
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (document.pictureInPictureEnabled && video.requestPictureInPicture) await video.requestPictureInPicture();
    else if (v.webkitSetPresentationMode) v.webkitSetPresentationMode(v.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture");
  } catch {
    // user gesture missing or not allowed
  }
}

export function audioTracks(video: HTMLVideoElement | null): AudioTrackListLike | null {
  const list = video ? w(video).audioTracks : undefined;
  return list && typeof list.length === "number" ? list : null;
}

export function audioProbe(video: HTMLVideoElement): AudioProbe {
  const v = w(video);
  const p: AudioProbe = {};
  if (typeof v.mozHasAudio === "boolean") p.mozHasAudio = v.mozHasAudio;
  if (typeof v.webkitAudioDecodedByteCount === "number") p.webkitAudioDecodedByteCount = v.webkitAudioDecodedByteCount;
  const tracks = audioTracks(video);
  if (tracks) p.audioTracks = tracks.length;
  return p;
}

export function bufferedRanges(video: HTMLVideoElement): [number, number][] {
  const out: [number, number][] = [];
  try {
    for (let i = 0; i < video.buffered.length; i++) out.push([video.buffered.start(i), video.buffered.end(i)]);
  } catch {
    // detached
  }
  return out;
}

export function seekableRanges(video: HTMLVideoElement): [number, number][] {
  const out: [number, number][] = [];
  try {
    for (let i = 0; i < video.seekable.length; i++) out.push([video.seekable.start(i), video.seekable.end(i)]);
  } catch {
    // detached
  }
  return out;
}

/** HTTP status of the stream URL (HEAD is answered by the API without touching TorrServer). */
export async function streamStatus(url: string): Promise<number> {
  try {
    const r = await fetch(url, { method: "HEAD", cache: "no-store", credentials: "omit" });
    return r.status;
  } catch {
    return 0;
  }
}

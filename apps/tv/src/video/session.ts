// The «Видео» player session: which video is on, where it starts, the
// quality cap and the list ▲▼ / the related panel came from. A tiny external
// store like live TV's, so App (device state, remote commands) and the player
// share it. The mounted player registers its controls for remote commands.
import { useSyncExternalStore } from "react";
import type { VideoPlayerInfo, VideoQuality, VideoRef } from "./logic";

export interface VideoSession {
  video: VideoRef;
  /** Start here (seconds); null = the server's resume position. */
  start: number | null;
  /** Height cap for this session; null = the profile's video_quality. */
  quality: VideoQuality | null;
  /** Bumped on every open (also of the same video: a fresh source). */
  seq: number;
}

/** What the mounted player does for remote controls (media.pause/resume/seek/stop/next_episode, video.play quality). */
export interface VideoControls {
  pause(): boolean;
  resume(): boolean;
  seek(position: number): boolean;
  /** Plays the first playable related video; false when there is none (yet). */
  next(): boolean;
  /** Switches the quality cap in place (continues from the current position). */
  quality(q: VideoQuality): boolean;
  /** Title, position, paused… for the device state. */
  info(): VideoPlayerInfo | null;
}

let current: VideoSession | null = null;
let seq = 0;
let controls: VideoControls | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
/** Playback changes (play/pause/seek/buffering/quality) for the device state. */
const changeListeners = new Set<() => void>();

export const videoSession = {
  get: () => current,
  active: () => current !== null,
  /** Starts (or switches to) a video. */
  open(video: VideoRef, opts: { start?: number | null; quality?: VideoQuality | null } = {}) {
    current = { video, start: opts.start ?? null, quality: opts.quality ?? current?.quality ?? null, seq: ++seq };
    emit();
  },
  close() {
    if (!current) return;
    current = null;
    emit();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  setControls(c: VideoControls | null) {
    controls = c;
    videoSession.changed();
  },
  /** The player's state changed (the device state is re-sent). */
  changed() {
    changeListeners.forEach((l) => l());
  },
  onChange(l: () => void) {
    changeListeners.add(l);
    return () => void changeListeners.delete(l);
  },
  controls: () => controls,
};

export function useVideoSession(): VideoSession | null {
  return useSyncExternalStore(videoSession.subscribe, videoSession.get);
}

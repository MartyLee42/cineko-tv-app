// The live TV session (which channel is on, and the list Up/Down switches
// through). A tiny external store like the VOD player's, so App (device
// state, remote commands) and the live player share it.
import { useSyncExternalStore } from "react";
import type { IptvChannel } from "@martytv/contracts";

export interface LiveSession {
  channel: IptvChannel;
  /** Channels Up/Down / numbers / the mini list switch through. */
  list: IptvChannel[];
  /** Bumped on every switch (also to the same channel: a fresh source). */
  seq: number;
}

/** What the mounted live player does for remote media.pause / media.resume. */
export interface LiveControls {
  pause(): boolean;
  resume(): boolean;
  paused(): boolean;
}

let current: LiveSession | null = null;
let seq = 0;
let controls: LiveControls | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
/** Play/pause changes (for the device state). */
const changeListeners = new Set<() => void>();

export const live = {
  get: () => current,
  active: () => current !== null,
  /** Starts (or switches) live playback. An empty list keeps the previous one. */
  open(channel: IptvChannel, list: IptvChannel[]) {
    const l = list.length > 0 ? list : (current?.list ?? [channel]);
    current = { channel, list: l.some((c) => c.id === channel.id) ? l : [channel, ...l], seq: ++seq };
    emit();
  },
  /** Switches to another channel of the session's list. */
  switchTo(channel: IptvChannel) {
    if (!current) return;
    current = { ...current, channel, seq: ++seq };
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
  setControls(c: LiveControls | null) {
    controls = c;
    live.changed();
  },
  controls: () => controls,
  /** The player paused / resumed (the device state is re-sent). */
  changed() {
    changeListeners.forEach((l) => l());
  },
  onChange(l: () => void) {
    changeListeners.add(l);
    return () => void changeListeners.delete(l);
  },
};

/**
 * media.pause / media.resume / media.stop on live TV (seek, tracks and
 * sources don't apply to a channel). Pure; the controls are injected.
 */
export function liveControl(type: string, c: LiveControls | null, close: () => void): true | "failed" | "unsupported" {
  switch (type) {
    case "stop":
      close();
      return true;
    case "pause":
      return c ? c.pause() || "failed" : "failed";
    case "resume":
      return c ? c.resume() || "failed" : "failed";
    default:
      return "unsupported";
  }
}

export function useLive(): LiveSession | null {
  return useSyncExternalStore(live.subscribe, live.get);
}

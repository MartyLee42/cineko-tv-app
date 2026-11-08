// «Cineko TV» switch (tiny, in the main bundle): whether the channel is on,
// and the hooks its lazy chunk registers so the player hands it the remote
// keys and the end of each title. Nothing is fetched until the viewer tunes in.
import { useSyncExternalStore } from "react";
import type { PlayerKey } from "../player/keys";

export interface ChannelRequest {
  profile_id: string;
  lang: "en" | "ru";
}

/** What the player tells the channel about a key. */
export interface KeyContext {
  /** The ▼ tracks panel is open (it keeps ▲▼ / OK / Back). */
  panel: boolean;
  /** An intro / credits pill is up (OK acts on it). */
  skip: boolean;
  /** Opens the player's audio / subtitles panel. */
  openPanel(): void;
}

export interface ChannelHooks {
  /** A remote key in the player; true = the channel handled it. */
  onKey(k: PlayerKey, ctx: KeyContext): boolean;
  /** The title played to its end (or reached the credits): true = the channel moves on. */
  onEnded(): boolean;
  /** Leaves the channel (playback stops). */
  leave(): void;
}

type Listener = () => void;
let request: ChannelRequest | null = null;
let hooks: ChannelHooks | null = null;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());

export const channelState = {
  /** Tune in (the App mounts the channel's lazy layer). */
  open(r: ChannelRequest) {
    request = r;
    emit();
  },
  /** Off: the layer unmounts (it stops playback itself). */
  close() {
    if (!request && !hooks) return;
    request = null;
    hooks = null;
    emit();
  },
  request: () => request,
  active: () => request !== null,
  hooks: () => hooks,
  setHooks(h: ChannelHooks | null) {
    hooks = h;
    emit();
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};

/** The channel request while on (null off). */
export function useChannel(): ChannelRequest | null {
  return useSyncExternalStore(channelState.subscribe, channelState.request, channelState.request);
}

/** Whether the channel drives the player right now. */
export function useChannelOn(): boolean {
  return useSyncExternalStore(channelState.subscribe, () => hooks !== null, () => false);
}

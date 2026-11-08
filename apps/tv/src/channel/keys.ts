// «Cineko TV»: what a remote key does on the channel (pure). Keys it doesn't
// claim (play/pause, ◀▶ seeking, …) stay the player's.
import type { PlayerKey } from "../player/keys";
import type { OsdMode } from "./session";

export type ChannelAction = "next" | "prev" | "guide" | "leave" | "hide" | "focus_prev" | "focus_next" | "press";

export interface OsdKeyState {
  osd: OsdMode;
  /** The player's tracks panel is open. */
  panel: boolean;
  /** An intro / credits pill wants OK. */
  skip: boolean;
}

export function osdKey(k: PlayerKey, s: OsdKeyState): ChannelAction | null {
  // CH± / ⏭⏮ switch picks whatever is shown.
  if (k === "chup" || k === "next") return "next";
  if (k === "chdown" || k === "prev") return "prev";
  if (k === "stop") return "leave";
  if (s.panel) return null;
  if (k === "up") return "next";
  if (k === "down") return "prev";
  if (s.osd === "guide") {
    if (k === "left") return "focus_prev";
    if (k === "right") return "focus_next";
    if (k === "ok") return "press";
    if (k === "back" || k === "guide") return "hide";
    return null;
  }
  if (k === "guide") return "guide";
  if (k === "ok") return s.skip ? null : "guide";
  if (k === "back") return s.osd === "strip" ? "hide" : "leave";
  return null;
}

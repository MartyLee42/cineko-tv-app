// This browser's settings class («Компьютер» / «Телефон»): the profile's look
// and playback behaviour are kept per class on the server
// (?device_class= on /profiles/{id}/settings). Detected once and stored, so
// resizing a window or rotating a phone never switches it; Settings can
// change it.
import { useSyncExternalStore } from "react";
import { detectDeviceClass, parseDeviceClass, type DeviceClass } from "@martytv/ui";

const KEY = "martytv.device_class";
const listeners = new Set<() => void>();
let current: DeviceClass | null = null;

function detect(): DeviceClass {
  if (typeof window === "undefined") return "desktop";
  let coarse = false;
  try {
    coarse = window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(any-pointer: fine)").matches;
  } catch {
    // old engines
  }
  return detectDeviceClass({ ua: navigator.userAgent, coarse, width: screen?.width ?? 0, height: screen?.height ?? 0 });
}

export const deviceClass = {
  get(): DeviceClass {
    if (current) return current;
    let stored: DeviceClass | null = null;
    try {
      stored = parseDeviceClass(localStorage.getItem(KEY));
    } catch {
      // private mode
    }
    current = stored ?? detect();
    if (!stored) {
      try {
        localStorage.setItem(KEY, current);
      } catch {
        // private mode
      }
    }
    return current;
  },
  set(c: DeviceClass) {
    current = c;
    try {
      localStorage.setItem(KEY, c);
    } catch {
      // private mode
    }
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useDeviceClass(): DeviceClass {
  return useSyncExternalStore(deviceClass.subscribe, deviceClass.get, deviceClass.get);
}

// Each design is its own chunk (its CSS + the components in looks/<id>.tsx),
// fetched when the design is applied: only the active design's chunk loads at
// startup, so the startup bundle stays the same size however many designs
// exist. main.tsx starts the saved design's chunk next to the app code and
// boot waits for it with the strings, so the first frame is fully styled.
// No React here (main.tsx imports it).
import type { DesignSetting } from "@martytv/ui";
import { retrying } from "../../retry";
import type { Look } from "./types";

type Mod = { look: Look };

const IMPORTS: Record<DesignSetting, () => Promise<Mod>> = {
  kinozal: () => import("./kinozal"),
  terminal: () => import("./terminal"),
  projector: () => import("./projector"),
  wireframe: () => import("./wireframe"),
  cyberpunk: () => import("./cyberpunk"),
  deco: () => import("./deco"),
  retro80: () => import("./retro80"),
  retro90: () => import("./retro90"),
  popart: () => import("./popart"),
  constructivism: () => import("./constructivism"),
  matrix: () => import("./matrix"),
  stickerbook: () => import("./stickerbook"),
  pocketpet: () => import("./pocketpet"),
  silent: () => import("./silent"),
  anderson: () => import("./anderson"),
};

const loaders = new Map<DesignSetting, () => Promise<Mod>>();
const looks = new Map<DesignSetting, Look>();
const listeners = new Set<() => void>();

/** Fetches a design's chunk (once; retried on a flaky network). Unknown ids resolve to nothing. */
export function loadLook(id: DesignSetting): Promise<void> {
  if (looks.has(id)) return Promise.resolve();
  const imp = IMPORTS[id];
  if (!imp) return Promise.resolve();
  let load = loaders.get(id);
  if (!load) loaders.set(id, (load = retrying(imp)));
  return load().then((m) => {
    if (looks.has(id)) return;
    looks.set(id, m.look);
    listeners.forEach((l) => l());
  });
}

/** The design's components, once its chunk is here (null before). */
export function getLook(id: DesignSetting): Look | null {
  return looks.get(id) ?? null;
}

export function subscribeLooks(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** main.tsx: the saved design's chunk travels next to the app code. */
export function preloadSavedLook(): void {
  let id: string | null = null;
  try {
    id = localStorage.getItem("martytv.design");
  } catch {
    /* private mode */
  }
  void loadLook((id && id in IMPORTS ? id : "kinozal") as DesignSetting).catch(() => undefined);
}

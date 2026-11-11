// The PWA's per-design scenery (the TV's design looks, redrawn for any window size).
// Each design's scene is its own chunk (with its CSS), fetched when the design is
// applied. The original three designs (Кинозал, Терминал, Проектор) draw nothing extra,
// like on the TV; «Конструктивизм» has its own full skin in constructivism.css.
import { useEffect, useState, type ComponentType } from "react";
import type { DesignSetting } from "@martytv/ui";

export interface WebLook {
  /** The fixed full-window background, behind everything (no input, aria-hidden). */
  Scene: ComponentType;
  /** Layers over Home's hero artwork (under its text). */
  HeroEdges?: ComponentType;
}

type Loader = () => Promise<{ look: WebLook }>;

export const LOOK_LOADERS: Partial<Record<DesignSetting, Loader>> = {
  wireframe: () => import("./scenes/wireframe"),
  cyberpunk: () => import("./scenes/cyberpunk"),
  deco: () => import("./scenes/deco"),
  retro80: () => import("./scenes/retro80"),
  retro90: () => import("./scenes/retro90"),
  popart: () => import("./scenes/popart"),
  matrix: () => import("./scenes/matrix"),
  stickerbook: () => import("./scenes/stickerbook"),
  pocketpet: () => import("./scenes/pocketpet"),
  odyssey: () => import("./scenes/odyssey"),
  mult: () => import("./scenes/mult"),
  tarkovsky: () => import("./scenes/tarkovsky"),
  silent: () => import("./scenes/silent"),
  anderson: () => import("./scenes/anderson"),
  noir: () => import("./scenes/noir"),
  vague: () => import("./scenes/vague"),
  western: () => import("./scenes/western"),
  redroom: () => import("./scenes/redroom"),
  fivestars: () => import("./scenes/fivestars"),
};

const loaded = new Map<DesignSetting, WebLook>();

/** The design's look once its chunk is in (null before, for the original three, or offline without the chunk). */
export function useWebLook(design: DesignSetting | null): WebLook | null {
  const [, setTick] = useState(0);
  const load = design ? LOOK_LOADERS[design] : undefined;
  useEffect(() => {
    if (!design || !load || loaded.has(design)) return;
    let live = true;
    load()
      .then((m) => {
        loaded.set(design, m.look);
        if (live) setTick((n) => n + 1);
      })
      .catch(() => undefined); // decoration only: the page works without it
    return () => {
      live = false;
    };
  }, [design, load]);
  return design ? (loaded.get(design) ?? null) : null;
}

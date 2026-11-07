// Which module draws each design's intro scene (each its own chunk, with its CSS).
// Tiny: App imports it to start the scene's download as soon as the intro is due.
import type { ComponentType } from "react";
import type { DesignSetting } from "@martytv/ui";

export type SceneMod = { Scene: ComponentType };
export const SCENE_IMPORTS: Record<DesignSetting, () => Promise<SceneMod>> = {
  kinozal: () => import("./scenes/kinozal"),
  terminal: () => import("./scenes/terminal"),
  projector: () => import("./scenes/projector"),
  wireframe: () => import("./scenes/wireframe"),
  cyberpunk: () => import("./scenes/cyberpunk"),
  deco: () => import("./scenes/deco"),
  retro80: () => import("./scenes/retro80"),
  retro90: () => import("./scenes/retro90"),
  popart: () => import("./scenes/popart"),
  constructivism: () => import("./scenes/constructivism"),
  matrix: () => import("./scenes/matrix"),
  stickerbook: () => import("./scenes/stickerbook"),
  pocketpet: () => import("./scenes/pocketpet"),
  odyssey: () => import("./scenes/odyssey"),
  mult: () => import("./scenes/mult"),
  tarkovsky: () => import("./scenes/tarkovsky"),
};

/** Starts fetching a design's scene (the intro shell itself is lazy too). */
export function preloadIntroScene(design: DesignSetting): void {
  void (SCENE_IMPORTS[design] ?? SCENE_IMPORTS.kinozal)().catch(() => undefined);
}

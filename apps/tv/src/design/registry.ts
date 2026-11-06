// Design registry (pure): design → { skeleton, skin }. The skeleton is one of
// the three original layouts (focus, scroll, navigation, menu order); the
// skin is what the design looks like on it (tokens + skin CSS under
// html.design-<id>, a background layer and a few ornaments in skins.tsx).
import { DESIGN_SKELETON, DESIGNS, designHasLight, type DesignSetting, type Skeleton } from "@martytv/ui";
import { KINOZAL_MENU, PROJECTOR_ICONS, PROJECTOR_TEXT, TERMINAL_MENU, type MenuId } from "./menuOrder";

export interface Skin {
  id: DesignSetting;
  skeleton: Skeleton;
  /** Has a light colour mode (Кинозал only). */
  light: boolean;
  /** Full-screen background layer drawn behind screens (null = plain bg colour / skeleton default). */
  background: "synthwave" | "city" | "lacquer" | "vhs" | "desktop" | "comic" | "poster" | null;
  /** Animated background layers (transform-only); the calm mode stops them. */
  animatedLayers: 0 | 1;
  /** Headline size factor on the skeleton's sizes (wide display faces need less). */
  titleScale: number;
  /** Ornaments the skin adds on its skeleton. */
  ornaments: { heroEdges: boolean; titlePlate: boolean; cornerBrackets: boolean };
}

const none = { heroEdges: false, titlePlate: false, cornerBrackets: false };

export const SKINS: Record<DesignSetting, Skin> = {
  kinozal: { id: "kinozal", skeleton: "kinozal", light: true, background: null, titleScale: 1, animatedLayers: 0, ornaments: none },
  terminal: { id: "terminal", skeleton: "terminal", light: false, background: null, titleScale: 1, animatedLayers: 0, ornaments: { ...none, cornerBrackets: true } },
  projector: { id: "projector", skeleton: "projector", light: false, background: null, titleScale: 1, animatedLayers: 0, ornaments: none },
  wireframe: { id: "wireframe", skeleton: "projector", light: false, background: "synthwave", titleScale: 0.74, animatedLayers: 1, ornaments: { ...none, heroEdges: true } },
  cyberpunk: { id: "cyberpunk", skeleton: "terminal", light: false, background: "city", titleScale: 1, animatedLayers: 0, ornaments: { ...none, cornerBrackets: true } },
  deco: { id: "deco", skeleton: "kinozal", light: false, background: "lacquer", titleScale: 1, animatedLayers: 0, ornaments: { ...none, heroEdges: true, titlePlate: true } },
  retro80: { id: "retro80", skeleton: "kinozal", light: false, background: "vhs", titleScale: 0.92, animatedLayers: 0, ornaments: { ...none, heroEdges: true } },
  retro90: { id: "retro90", skeleton: "terminal", light: false, background: "desktop", titleScale: 0.9, animatedLayers: 0, ornaments: none },
  // Rubik Mono One is very wide: titles a size smaller.
  popart: { id: "popart", skeleton: "projector", light: false, background: "comic", titleScale: 0.72, animatedLayers: 0, ornaments: { ...none, heroEdges: true } },
  constructivism: { id: "constructivism", skeleton: "terminal", light: false, background: "poster", titleScale: 1, animatedLayers: 0, ornaments: none },
};

export { DESIGNS };

/** Каркас floor: cross lines spaced by this ratio, so one animation step scales by 1/FLOOR_R (index.css sw-run). */
export const FLOOR_R = 0.78;

/** The skin of a design id (unknown → Кинозал). */
export function skinOf(design: string): Skin {
  return SKINS[design as DesignSetting] ?? SKINS.kinozal;
}

/** Light mode allowed for this design (others are always dark). */
export const hasLight = (design: DesignSetting) => designHasLight(design) && SKINS[design].light;

/**
 * The menu items a design shows, in order: always its skeleton's shared
 * list (menuOrder.ts), so tabs added there (e.g. «ТВ») appear in every skin.
 */
export function menuItems(design: DesignSetting): MenuId[] {
  switch (DESIGN_SKELETON[design] ?? "kinozal") {
    case "terminal":
      return TERMINAL_MENU;
    case "projector":
      return [...PROJECTOR_TEXT, ...PROJECTOR_ICONS];
    default:
      return KINOZAL_MENU;
  }
}

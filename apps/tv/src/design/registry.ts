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
  background: "synthwave" | "city" | "lacquer" | "vhs" | "desktop" | "comic" | "poster" | "rain" | "stickers" | "lcd" | "corridor" | "intertitle" | "symmetry" | "gouache" | "rainwater" | "blinds" | "cards" | "desert" | "curtains" | "sunset" | null;
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
  stickerbook: { id: "stickerbook", skeleton: "kinozal", light: false, background: "stickers", titleScale: 1, animatedLayers: 0, ornaments: { ...none, heroEdges: true, titlePlate: true } },
  // Press Start 2P is a wide monospaced pixel face: titles much smaller.
  pocketpet: { id: "pocketpet", skeleton: "terminal", light: false, background: "lcd", titleScale: 0.6, animatedLayers: 0, ornaments: none },
  // Wide letter-spaced capitals (Unbounded Light): titles a size smaller. A static white corridor.
  odyssey: { id: "odyssey", skeleton: "projector", light: false, background: "corridor", titleScale: 0.7, animatedLayers: 0, ornaments: none },
  // Mono display type runs wide: titles a little smaller.
  matrix: { id: "matrix", skeleton: "terminal", light: false, background: "rain", titleScale: 0.86, animatedLayers: 0, ornaments: { ...none, cornerBrackets: true } },
  // Light by design (no dark/light switch, like Тамагочи): `light` is the colour-mode toggle.
  mult: { id: "mult", skeleton: "kinozal", light: false, background: "gouache", titleScale: 1, animatedLayers: 1, ornaments: { ...none, heroEdges: true, titlePlate: true } },
  tarkovsky: { id: "tarkovsky", skeleton: "kinozal", light: false, background: "rainwater", titleScale: 1, animatedLayers: 1, ornaments: { ...none, heroEdges: true } },
  // Silent-film intertitles: the one animated layer is a faint projector flicker (off when calm).
  silent: { id: "silent", skeleton: "projector", light: false, background: "intertitle", titleScale: 0.9, animatedLayers: 1, ornaments: { ...none, heroEdges: true, titlePlate: true } },
  // Jost runs narrow and geometric; the hero title is centred.
  anderson: { id: "anderson", skeleton: "projector", light: false, background: "symmetry", titleScale: 0.9, animatedLayers: 0, ornaments: { ...none, heroEdges: true, titlePlate: true } },
  // Typewriter mono runs wide: titles a little smaller. One slow rain layer on the window.
  noir: { id: "noir", skeleton: "terminal", light: false, background: "blinds", titleScale: 0.84, animatedLayers: 1, ornaments: none },
  vague: { id: "vague", skeleton: "terminal", light: false, background: "cards", titleScale: 1, animatedLayers: 0, ornaments: none },
  western: { id: "western", skeleton: "kinozal", light: false, background: "desert", titleScale: 1, animatedLayers: 0, ornaments: { ...none, heroEdges: true, titlePlate: true } },
  // Playfair runs wide in capitals: titles a touch smaller.
  redroom: { id: "redroom", skeleton: "projector", light: false, background: "curtains", titleScale: 0.9, animatedLayers: 0, ornaments: { ...none, heroEdges: true } },
  // Oswald capitals run narrow but heavy with the outline: titles a touch smaller. The glints on the bay's water are the one animated layer.
  fivestars: { id: "fivestars", skeleton: "projector", light: false, background: "sunset", titleScale: 0.92, animatedLayers: 1, ornaments: { ...none, heroEdges: true } },
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

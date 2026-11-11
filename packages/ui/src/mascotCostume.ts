// Cineko's costume per design (a small SVG over the sticker, like the
// seasonal hats) and where it sits on each sticker. Pure: no React.
//
//   deco      → a top hat (on the head)        retro90 → a pixel-cat badge (corner)
//   cyberpunk → a visor (over the eyes)        matrix  → sunglasses (over the eyes)
//   popart    → a speech bubble (corner)       constructivism → no mascot at all (Mayakovsky)
//   fivestars → gold aviators with sunset lenses (over the eyes)
import type { DesignSetting } from "./designs";
import type { MascotMood } from "./marty";
import type { MascotHatId } from "./seasonStore";

export type Costume = "tophat" | "pixelcat" | "visor" | "sunglasses" | "bubble" | "aviators";

/** Where a costume goes: on the head, over the eyes, or in a corner of the box. */
export type CostumeSlot = "head" | "face" | "corner";

export const COSTUME_OF: Partial<Record<DesignSetting, Costume>> = {
  deco: "tophat",
  retro90: "pixelcat",
  cyberpunk: "visor",
  matrix: "sunglasses",
  popart: "bubble",
  fivestars: "aviators",
};

export const COSTUME_SLOT: Record<Costume, CostumeSlot> = {
  tophat: "head",
  pixelcat: "corner",
  visor: "face",
  sunglasses: "face",
  bubble: "corner",
  aviators: "face",
};

/**
 * The still stickers' geometry, measured on the artwork: image size (px),
 * the two eye centres and the top of the head, as fractions of the image.
 * Moods missing here (or without eyes / with the head covered) get no head
 * or face item — a costume that floats off the cat is worse than none.
 */
interface StickerGeometry {
  w: number;
  h: number;
  eyes?: [[number, number], [number, number]];
  head?: [number, number];
}

const GEOMETRY: Partial<Record<MascotMood, StickerGeometry>> = {
  idle: { w: 295, h: 320, eyes: [[0.604, 0.417], [0.792, 0.45]], head: [0.57, 0.17] },
  happy: { w: 186, h: 206, eyes: [[0.54, 0.42], [0.81, 0.46]], head: [0.52, 0.16] },
  popcorn: { w: 212, h: 247, eyes: [[0.46, 0.375], [0.7, 0.41]], head: [0.46, 0.14] },
  surprised: { w: 182, h: 233, eyes: [[0.56, 0.57], [0.81, 0.57]], head: [0.55, 0.33] },
  // Under the umbrella: no hat.
  rain: { w: 210, h: 187, eyes: [[0.66, 0.65], [0.83, 0.65]] },
  // One ring «eye»: a hat, but nothing over the eyes.
  loading: { w: 171, h: 183, head: [0.5, 0.13] },
  love: { w: 210, h: 214, eyes: [[0.44, 0.44], [0.66, 0.44]], head: [0.46, 0.12] },
  sleepy: { w: 280, h: 196, eyes: [[0.28, 0.79], [0.42, 0.79]], head: [0.33, 0.4] },
};

/** A point in the mascot box's 0..120 SVG space. */
export interface Pt {
  x: number;
  y: number;
}

/** Image fractions → box coordinates (the sticker is object-contain in a 120×120 box). */
function toBox(g: StickerGeometry, [fx, fy]: [number, number]): Pt {
  const s = 120 / Math.max(g.w, g.h);
  const w = g.w * s;
  const h = g.h * s;
  return { x: (120 - w) / 2 + fx * w, y: (120 - h) / 2 + fy * h };
}

export interface CostumePlan {
  costume: Costume;
  /** Head and face items are measured on the still sticker: show that, not the animated loop (whose frames move). */
  still: boolean;
  /** Face items: the two eye centres. */
  eyes?: [Pt, Pt];
  /** Head items: the top of the head. */
  head?: Pt;
}

/**
 * The costume to draw for this design, seasonal hat and mood — or null.
 * A seasonal hat (Santa, witch) wins over a head costume (no two hats);
 * face and corner items combine with it.
 */
export function costumePlan(design: DesignSetting | null, hat: MascotHatId | undefined, mood: MascotMood): CostumePlan | null {
  if (!design) return null;
  const costume = COSTUME_OF[design];
  if (!costume) return null;
  const slot = COSTUME_SLOT[costume];
  if (slot === "corner") return { costume, still: false };
  const g = GEOMETRY[mood];
  if (!g) return null;
  if (slot === "head") {
    if (hat || !g.head) return null;
    return { costume, still: true, head: toBox(g, g.head) };
  }
  if (!g.eyes) return null;
  return { costume, still: true, eyes: [toBox(g, g.eyes[0]), toBox(g, g.eyes[1])] };
}

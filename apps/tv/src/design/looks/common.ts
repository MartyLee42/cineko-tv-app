// Helpers shared by the design looks (looks/<id>.tsx).

/** A full-screen background layer (1920×1080, behind everything, no input). */
export const layer = "pointer-events-none absolute left-0 top-0 h-[1080px] w-[1920px]";

/** Deterministic pseudo-random numbers (stable SVG between renders): shared with the PWA's scenes. */
export { rand } from "@martytv/ui/decor";

// Helpers shared by the design looks (looks/<id>.tsx).

/** A full-screen background layer (1920×1080, behind everything, no input). */
export const layer = "pointer-events-none absolute left-0 top-0 h-[1080px] w-[1920px]";

/** Deterministic pseudo-random numbers (stable SVG between renders). */
export function rand(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

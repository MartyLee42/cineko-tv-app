// «Тамагочи»: pixel-art sprites (rows of text, "#" = an ink pixel), shared by
// the look's pet and the startup intro. Pure data: no CSS, no app imports.
import type { PetMood } from "./pocketpetMood";

export const INK = "rgb(24,32,18)";
export const LCD = "rgb(196,208,170)";

/** One path of 1×1 squares for every `ch` in a sprite, offset by x, y (draw with shape-rendering: crispEdges). */
export function pixels(rows: readonly string[], ch = "#", x = 0, y = 0): string {
  let d = "";
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) if (row[c] === ch) d += `M${x + c} ${y + r}h1v1h-1z`;
  });
  return d;
}

/** A path of single pixels at [col, row]. */
export const dots = (pts: readonly (readonly [number, number])[]) => pts.map(([c, r]) => `M${c} ${r}h1v1h-1z`).join("");

// Cineko: a dark robot-cat (ears, a round head that is all visor, a little body with paws), 16×15.
export const BODY = [
  "..#..........#..",
  "..##........##..",
  ".####......####.",
  ".##############.",
  "################",
  "################",
  "################",
  "################",
  "################",
  ".##############.",
  "..############..",
  "....########....",
  "...##########...",
  "...##.####.##...",
  "...###.##.###...",
];

export type Face = PetMood | "eat" | "sleep";

/** Lit (LCD-coloured) pixels on the dark head: eyes and mouth per face. */
export const FACE: Record<Face, readonly (readonly [number, number])[]> = {
  sad: [[5, 6], [3, 7], [4, 7], [10, 6], [11, 7], [12, 7], [3, 8], [7, 9], [8, 9], [6, 10], [9, 10]],
  neutral: [[4, 6], [5, 6], [4, 7], [5, 7], [10, 6], [11, 6], [10, 7], [11, 7], [7, 9], [8, 9]],
  happy: [[4, 6], [5, 6], [3, 7], [6, 7], [10, 6], [11, 6], [9, 7], [12, 7], [6, 9], [9, 9], [7, 10], [8, 10]],
  ecstatic: [[3, 5], [5, 5], [3, 6], [4, 6], [5, 6], [4, 7], [10, 5], [12, 5], [10, 6], [11, 6], [12, 6], [11, 7], [6, 9], [9, 9], [7, 10], [8, 10]],
  eat: [[4, 6], [5, 6], [3, 7], [6, 7], [10, 6], [11, 6], [9, 7], [12, 7], [7, 9], [8, 9], [7, 10], [8, 10]],
  sleep: [[3, 7], [4, 7], [5, 7], [10, 7], [11, 7], [12, 7], [7, 9]],
};
/** The little light on the chest. */
export const CHEST = [[7, 12], [8, 12]] as const;

export const HEART = [".##.##.", "#######", "#######", ".#####.", "..###..", "...#..."];
export const HEART_EMPTY = [".##.##.", "#..#..#", "#.....#", ".#...#.", "..#.#..", "...#..."];
export const POPCORN = [".#.#.", "#####", "#.#.#", "#.#.#", ".###."];
export const SPARKLE = [".#.", "###", ".#."];

/** The egg of the intro (12×14): whole, then its two halves meeting at a jagged crack (rows 7 / 8). */
export const EGG_TOP = [
  "....####....",
  "..##....##..",
  ".#........#.",
  ".#..##....#.",
  "#..####....#",
  "#...##.....#",
  "#..........#",
  "#.#.#..#.#.#",
];
export const EGG_BOTTOM = [
  ".#.#.##.#.#.",
  "#......##..#",
  "#.....####.#",
  ".#.....##.#.",
  "..##....##..",
  "....####....",
];
export const EGG_WHOLE = [...EGG_TOP.slice(0, 7), "#..........#", "#..........#", ...EGG_BOTTOM.slice(1)];

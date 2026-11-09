// Sticker specs: the parametric die-cut design (a shape, a palette, a glyph,
// and for counter tiers a metal ring with a ribbon). The first four have
// hand-drawn art (Keepsakes.tsx). Keys are the API's achievement ids
// (services/api/internal/keepsakes/stickers.go; a Go test checks this file
// has every one): one per line, `  <id>: …`.

export type Shape = "circle" | "scallop" | "flower" | "hexagon" | "frame" | "bubble" | "blob" | "star";

export type Hue =
  | "orange" | "amber" | "red" | "rose" | "plum" | "violet" | "navy" | "sky" | "teal"
  | "mint" | "lime" | "forest" | "sand" | "cocoa" | "slate" | "charcoal";

/** bg: the sticker; hi: its soft highlight; ink: dark details; light: the glyph's paper. */
export interface Palette {
  bg: string;
  hi: string;
  ink: string;
  light: string;
}

export const PALETTES: Record<Hue, Palette> = {
  orange: { bg: "#ff8a3d", hi: "#ffb36b", ink: "#4a2408", light: "#fff3e3" },
  amber: { bg: "#ffbe3b", hi: "#ffd77a", ink: "#4f3300", light: "#fff8e6" },
  red: { bg: "#e8484a", hi: "#ff7d75", ink: "#4a0d10", light: "#ffece8" },
  rose: { bg: "#ff7fa2", hi: "#ffb0c4", ink: "#5a1530", light: "#fff0f4" },
  plum: { bg: "#9b4fc9", hi: "#c286ec", ink: "#2c0b40", light: "#f7ecff" },
  violet: { bg: "#6c63ff", hi: "#9b95ff", ink: "#1b1650", light: "#efeeff" },
  navy: { bg: "#26346e", hi: "#3f4f9a", ink: "#0d1330", light: "#fff2c9" },
  sky: { bg: "#3fa9f5", hi: "#86cdfb", ink: "#0b3352", light: "#eaf6ff" },
  teal: { bg: "#22b3a3", hi: "#6ad9cb", ink: "#073d37", light: "#e7fffb" },
  mint: { bg: "#59d49b", hi: "#93ebc3", ink: "#0b4128", light: "#ecfff5" },
  lime: { bg: "#a4d43b", hi: "#c8ec79", ink: "#2c3b06", light: "#f7ffe6" },
  forest: { bg: "#2f8f5b", hi: "#5cb987", ink: "#0b2b1a", light: "#eafff2" },
  sand: { bg: "#e9c27b", hi: "#f5dca8", ink: "#5b3a1e", light: "#fffaf0" },
  cocoa: { bg: "#8a5a3c", hi: "#b0805e", ink: "#2b1a10", light: "#fff1e2" },
  slate: { bg: "#5d6b7e", hi: "#8796aa", ink: "#1a2230", light: "#eef3f8" },
  charcoal: { bg: "#2c2c34", hi: "#4a4a56", ink: "#0f0f12", light: "#f2f2f5" },
};

/** Tier metals, easiest first: bronze, silver, gold, platinum, ruby, diamond. */
export interface Metal {
  fill: string;
  hi: string;
  dark: string;
}

export const METALS: readonly Metal[] = [
  { fill: "#d38b52", hi: "#f0b98a", dark: "#7a4519" },
  { fill: "#c9d1da", hi: "#f2f5f8", dark: "#5d6875" },
  { fill: "#f2c94c", hi: "#fff1a8", dark: "#8a6400" },
  { fill: "#9fe6df", hi: "#e2fffb", dark: "#2a6e68" },
  { fill: "#ff5d73", hi: "#ffc0c9", dark: "#7a0f22" },
  { fill: "#b9a6ff", hi: "#ece6ff", dark: "#4a3a9a" },
];

/** Metal of tier 1…6 (clamped). */
export function metalFor(tier: number): Metal {
  return METALS[Math.max(0, Math.min(METALS.length - 1, Math.round(tier) - 1))]!;
}

export type Glyph =
  | "ticket" | "tv" | "clapper" | "clock" | "sunrise" | "bowl" | "calendar" | "flame" | "tree" | "heart"
  | "grin" | "pumpkin" | "projector" | "popcorn" | "remote" | "tickets2" | "tickets3" | "paw" | "hourglass"
  | "bowler" | "ghost" | "mask_happy" | "mask_sad" | "palette" | "camera" | "rocket" | "hat" | "note"
  | "helmet" | "hearts" | "fedora" | "magnifier" | "castle" | "column" | "house" | "bolt" | "burst"
  | "compass" | "cocktail" | "bubbles" | "taeguk" | "torii" | "lotus" | "eiffel" | "pizza" | "fan"
  | "lantern" | "star5" | "sakura" | "globe" | "filmcans" | "stopwatch" | "spotlight" | "bell" | "laurel"
  | "trash" | "gem" | "statuette" | "infinity" | "plane" | "loop" | "loop_heart" | "tomato" | "peel";

export interface StickerSpec {
  /** Hand-drawn art (the first four). */
  bespoke?: true;
  shape: Shape;
  hue: Hue;
  /** A drawn glyph, or big digits (`text`, with an optional small line above). */
  glyph?: Glyph;
  text?: string;
  over?: string;
  /** Counter tiers: the metal ring (1 = bronze … 6 = diamond) and the ribbon's number. */
  tier?: number;
  ribbon?: string;
}

const bespoke: StickerSpec = { bespoke: true, shape: "circle", hue: "orange" };
const tier = (glyph: Glyph, hue: Hue, n: number, ribbon: string, shape: Shape = "scallop"): StickerSpec => ({ shape, hue, glyph, tier: n, ribbon });
const g = (shape: Shape, hue: Hue, glyph: Glyph): StickerSpec => ({ shape, hue, glyph });
const txt = (shape: Shape, hue: Hue, text: string, over?: string): StickerSpec => ({ shape, hue, text, over });
const decade = (hue: Hue, y: number): StickerSpec => txt("frame", hue, String(y % 100).padStart(2, "0"), String(Math.floor(y / 100)));

/** Every sticker, in the API's rule order. */
export const SPECS = {
  marathon: bespoke,
  archaeologist: bespoke,
  polyglot: bespoke,
  night_owl: bespoke,
  films_1: tier("ticket", "red", 1, "1"),
  films_10: tier("ticket", "red", 2, "10"),
  films_50: tier("ticket", "red", 3, "50"),
  films_100: tier("ticket", "red", 4, "100"),
  films_250: tier("ticket", "red", 5, "250"),
  films_500: tier("ticket", "red", 6, "500"),
  episodes_10: tier("tv", "sky", 1, "10"),
  episodes_100: tier("tv", "sky", 2, "100"),
  episodes_500: tier("tv", "sky", 3, "500"),
  episodes_1000: tier("tv", "sky", 4, "1000"),
  series_done_1: tier("clapper", "violet", 1, "1"),
  series_done_5: tier("clapper", "violet", 2, "5"),
  series_done_20: tier("clapper", "violet", 3, "20"),
  hours_24: tier("clock", "teal", 1, "24"),
  hours_100: tier("clock", "teal", 2, "100"),
  hours_500: tier("clock", "teal", 3, "500"),
  early_bird: g("circle", "amber", "sunrise"),
  lunch_break: g("circle", "lime", "bowl"),
  all_week: g("circle", "sky", "calendar"),
  streak_7: tier("flame", "orange", 2, "7"),
  streak_30: tier("flame", "orange", 3, "30"),
  new_year: g("flower", "forest", "tree"),
  valentine: g("flower", "rose", "heart"),
  april_fools: g("flower", "amber", "grin"),
  halloween: g("flower", "charcoal", "pumpkin"),
  friday_13: txt("flower", "slate", "13"),
  leap_day: txt("flower", "mint", "29"),
  cinema_day: g("flower", "red", "projector"),
  weekend_fest: g("circle", "plum", "popcorn"),
  binge_day: g("circle", "navy", "remote"),
  double_feature: g("circle", "orange", "tickets2"),
  triple_feature: g("circle", "red", "tickets3"),
  nine_lives: g("circle", "cocoa", "paw"),
  decade_1920s: decade("sand", 1920),
  decade_1930s: decade("cocoa", 1930),
  decade_1940s: decade("slate", 1940),
  decade_1950s: decade("rose", 1950),
  decade_1960s: decade("orange", 1960),
  decade_1970s: decade("amber", 1970),
  decade_1980s: decade("plum", 1980),
  decade_1990s: decade("teal", 1990),
  decade_2000s: decade("sky", 2000),
  decade_2010s: decade("violet", 2010),
  decade_2020s: decade("mint", 2020),
  time_machine: { shape: "blob", hue: "violet", glyph: "hourglass", tier: 3 },
  silent: g("frame", "charcoal", "bowler"),
  genre_horror: g("hexagon", "charcoal", "ghost"),
  genre_comedy: g("hexagon", "amber", "mask_happy"),
  genre_animation: g("hexagon", "sky", "palette"),
  genre_documentary: g("hexagon", "slate", "camera"),
  genre_scifi: g("hexagon", "navy", "rocket"),
  genre_western: g("hexagon", "sand", "hat"),
  genre_music: g("hexagon", "plum", "note"),
  genre_war: g("hexagon", "forest", "helmet"),
  genre_romance: g("hexagon", "rose", "hearts"),
  genre_crime: g("hexagon", "cocoa", "fedora"),
  genre_mystery: g("hexagon", "violet", "magnifier"),
  genre_fantasy: g("hexagon", "teal", "castle"),
  genre_history: g("hexagon", "sand", "column"),
  genre_family: g("hexagon", "mint", "house"),
  genre_thriller: g("hexagon", "lime", "bolt"),
  genre_action: g("hexagon", "orange", "burst"),
  genre_adventure: g("hexagon", "teal", "compass"),
  genre_drama: g("hexagon", "red", "mask_sad"),
  genre_mix: { shape: "hexagon", hue: "plum", glyph: "cocktail", tier: 3 },
  polyglot_10: tier("bubbles", "teal", 2, "10"),
  polyglot_20: tier("bubbles", "teal", 3, "20"),
  lang_korean: g("bubble", "sand", "taeguk"),
  lang_japanese: g("bubble", "sky", "torii"),
  lang_indian: g("bubble", "orange", "lotus"),
  lang_french: g("bubble", "navy", "eiffel"),
  lang_italian: g("bubble", "forest", "pizza"),
  lang_spanish: g("bubble", "amber", "fan"),
  lang_chinese: g("bubble", "red", "lantern"),
  soviet: g("circle", "red", "star5"),
  anime: g("bubble", "violet", "sakura"),
  world_10: tier("globe", "mint", 1, "10"),
  world_25: tier("globe", "mint", 2, "25"),
  epic: g("blob", "cocoa", "filmcans"),
  short: g("blob", "mint", "stopwatch"),
  premiere: g("blob", "red", "spotlight"),
  fresh_episode: g("blob", "sky", "bell"),
  masterpiece: g("blob", "plum", "laurel"),
  cult_trash: g("blob", "lime", "trash"),
  hidden_gem: g("blob", "violet", "gem"),
  oscar: g("star", "navy", "statuette"),
  long_series: g("blob", "navy", "infinity"),
  pilots_10: g("blob", "sky", "plane"),
  rewatch: g("blob", "teal", "loop"),
  rewatch_3: g("blob", "rose", "loop_heart"),
  rated_10: tier("star5", "navy", 1, "10"),
  rated_50: tier("star5", "navy", 2, "50"),
  perfect_10: txt("star", "amber", "10"),
  harsh_1: g("circle", "slate", "tomato"),
  collector_10: tier("peel", "plum", 1, "10"),
  collector_25: tier("peel", "plum", 2, "25"),
  collector_50: tier("peel", "plum", 3, "50"),
} satisfies Record<string, StickerSpec>;

export type StickerId = keyof typeof SPECS;

/** Sticker ids with art, in rule order (the API may add more later: unknown ids are skipped). */
export const STICKERS = Object.keys(SPECS) as StickerId[];

// ---------------------------------------------------------------- shapes

const C = 60;
const f1 = (n: number) => (Math.round(n * 10) / 10).toString();

/** A closed path through r(θ), sampled every 360/n degrees. */
function polar(n: number, r: (a: number) => number): string {
  let d = "";
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const rr = r(a);
    d += `${i ? "L" : "M"}${f1(C + rr * Math.cos(a))} ${f1(C + rr * Math.sin(a))} `;
  }
  return d + "Z";
}

function polygon(points: number, rOuter: number, rInner: number, turn = 0): string {
  let d = "";
  const n = rInner ? points * 2 : points;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2 + turn;
    const r = rInner && i % 2 ? rInner : rOuter;
    d += `${i ? "L" : "M"}${f1(C + r * Math.cos(a))} ${f1(C + r * Math.sin(a))} `;
  }
  return d + "Z";
}

const CIRCLE = "M60 11 A49 49 0 1 1 59.9 11 Z";

/** The body of each shape in the 120×120 box (radius ≈ 49; the die-cut margin is a stroke around it). */
export const SHAPES: Record<Shape, string[]> = {
  circle: [CIRCLE],
  scallop: [polar(144, (a) => 47 + 2.6 * Math.cos(a * 18))],
  flower: [polar(144, (a) => 44.5 + 5 * Math.cos(a * 8))],
  hexagon: [polygon(6, 50, 0)],
  frame: ["M24 18 H96 A10 10 0 0 1 106 28 V92 A10 10 0 0 1 96 102 H24 A10 10 0 0 1 14 92 V28 A10 10 0 0 1 24 18 Z"],
  bubble: ["M60 13 A45 43 0 1 1 33 91 L18 104 L24 82 A45 43 0 0 1 60 13 Z"],
  blob: ["M60 10 C82 10 96 20 104 34 C113 50 112 72 102 88 C92 104 74 110 57 109 C38 108 22 99 15 82 C8 64 11 42 23 28 C32 17 45 10 60 10 Z"],
  star: [polygon(5, 54, 33)],
};

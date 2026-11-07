// The main app's visual designs (tokens vendored in ../shared/theme.css).
// <html> gets `design-<id>` + `skel-<skeleton>`; Кинозал alone has a light mode.
export type DesignId = "kinozal" | "terminal" | "projector" | "wireframe" | "cyberpunk" | "deco" | "retro80" | "retro90" | "popart" | "constructivism" | "matrix" | "stickerbook" | "pocketpet" | "odyssey" | "mult" | "tarkovsky";
export type Skeleton = "kinozal" | "terminal" | "projector";

export const DESIGNS: DesignId[] = ["kinozal", "terminal", "projector", "wireframe", "cyberpunk", "deco", "retro80", "retro90", "popart", "constructivism", "matrix", "stickerbook", "pocketpet", "odyssey", "mult", "tarkovsky"];


export const DESIGN_SKELETON: Record<DesignId, Skeleton> = {
  kinozal: "kinozal",
  terminal: "terminal",
  projector: "projector",
  wireframe: "projector",
  cyberpunk: "terminal",
  deco: "kinozal",
  retro80: "kinozal",
  retro90: "terminal",
  popart: "projector",
  constructivism: "terminal",
  matrix: "terminal",
  stickerbook: "kinozal",
  pocketpet: "terminal",
  odyssey: "projector",
  mult: "kinozal",
  tarkovsky: "kinozal",
};

export const DESIGN_NAMES: Record<DesignId, { ru: string; kk: string; en: string }> = {
  kinozal: { ru: "Кинозал", kk: "Кинозал", en: "Cinema" },
  terminal: { ru: "Терминал", kk: "Терминал", en: "Terminal" },
  projector: { ru: "Проектор", kk: "Проектор", en: "Projector" },
  wireframe: { ru: "Каркас", kk: "Қаңқа", en: "Wireframe" },
  cyberpunk: { ru: "Киберпанк", kk: "Киберпанк", en: "Cyberpunk" },
  deco: { ru: "Ар-деко", kk: "Ар-деко", en: "Art Deco" },
  retro80: { ru: "Ретро 80-е", kk: "Ретро 80-ші", en: "Retro 80s" },
  retro90: { ru: "Ретро 90-е", kk: "Ретро 90-шы", en: "Retro 90s" },
  popart: { ru: "Поп-арт", kk: "Поп-арт", en: "Pop Art" },
  constructivism: { ru: "Конструктивизм", kk: "Конструктивизм", en: "Constructivism" },
  matrix: { ru: "Матрица", kk: "Матрица", en: "Matrix" },
  stickerbook: { ru: "Стикербук", kk: "Стикербук", en: "Sticker Book" },
  pocketpet: { ru: "Тамагочи", kk: "Тамагочи", en: "Pocket Pet" },
  odyssey: { ru: "Одиссея", kk: "Одиссея", en: "Odyssey" },
  mult: { ru: "Мультфильм", kk: "Мультфильм", en: "Cartoon" },
  tarkovsky: { ru: "Созерцание", kk: "Толғаныс", en: "Contemplation" },
};

export const DESIGN_SWATCH: Record<DesignId, { bg: string; surface: string; accent: string; accent2: string; text: string }> = {
  kinozal: { bg: "#08090c", surface: "#1d1f20", accent: "#c8ff3d", accent2: "#c8ff3d", text: "#f2f4f8" },
  terminal: { bg: "#070708", surface: "#1a1a1c", accent: "#ff6b3d", accent2: "#ff6b3d", text: "#ecece8" },
  projector: { bg: "#05090b", surface: "#12262a", accent: "#5fd6c8", accent2: "#5fd6c8", text: "#f4f8f8" },
  wireframe: { bg: "#0d0420", surface: "#1e0f3d", accent: "#ff4fd8", accent2: "#3ce8ff", text: "#f6efff" },
  cyberpunk: { bg: "#06060a", surface: "#14141c", accent: "#f5f03c", accent2: "#ff2e88", text: "#eef6ff" },
  deco: { bg: "#0b0a08", surface: "#1a1712", accent: "#c9a54c", accent2: "#e8cf8a", text: "#f3ead6" },
  retro80: { bg: "#0b0e2a", surface: "#1a1f4a", accent: "#ff7a1a", accent2: "#16e0d0", text: "#fff4e6" },
  retro90: { bg: "#006e6e", surface: "#101870", accent: "#ffe85c", accent2: "#c0c0c0", text: "#ffffff" },
  popart: { bg: "#143a96", surface: "#0e2262", accent: "#ffd600", accent2: "#ff2d3c", text: "#ffffff" },
  constructivism: { bg: "#181412", surface: "#28221e", accent: "#d7261e", accent2: "#efe4cc", text: "#f3ead6" },
  matrix: { bg: "#000602", surface: "#04140a", accent: "#00ff41", accent2: "#c8ffd2", text: "#b4ffc4" },
  stickerbook: { bg: "#2a2438", surface: "#3a3250", accent: "#ff6fa5", accent2: "#5fd3c4", text: "#fff8ef" },
  pocketpet: { bg: "#f3c6dc", surface: "#b9c9a0", accent: "#2f3a24", accent2: "#8fd3e8", text: "#1f2818" },
  odyssey: { bg: "#eef1f4", surface: "#ffffff", accent: "#101318", accent2: "#e21e16", text: "#101318" },
  mult: { bg: "#f3e9d6", surface: "#fffaf0", accent: "#c4532f", accent2: "#6f9fb4", text: "#3a2a20" },
  tarkovsky: { bg: "#141613", surface: "#22241f", accent: "#c8a46a", accent2: "#7f9a8c", text: "#e2dccb" },
};

export function isDesign(v: unknown): v is DesignId {
  return typeof v === "string" && (DESIGNS as string[]).includes(v);
}

export function applyDesign(design: DesignId, light: boolean): void {
  const d = isDesign(design) ? design : "kinozal";
  const root = document.documentElement;
  for (const x of DESIGNS) root.classList.toggle(`design-${x}`, x === d);
  for (const s of ["kinozal", "terminal", "projector"]) root.classList.toggle(`skel-${s}`, s === DESIGN_SKELETON[d]);
  root.classList.toggle("theme-light", d === "kinozal" && light);
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = d === "kinozal" && light ? "#f4f5f0" : DESIGN_SWATCH[d].bg;
}

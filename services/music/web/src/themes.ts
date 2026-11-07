// Cineko's designs in Cineko Music. By default the design chosen in Cineko
// is used (same origin: its "martytv.design" localStorage key); Music can
// also pick its own ("mm.design").

export const DESIGNS = [
  { id: "kinozal", name: "Кинозал", bg: "#08090c", surface: "#1d1f20", accent: "#c8ff3d", accent2: "#c8ff3d" },
  { id: "terminal", name: "Терминал", bg: "#070708", surface: "#1a1a1c", accent: "#ff6b3d", accent2: "#ff6b3d" },
  { id: "projector", name: "Проектор", bg: "#05090b", surface: "#12262a", accent: "#5fd6c8", accent2: "#5fd6c8" },
  { id: "wireframe", name: "Каркас", bg: "#0d0420", surface: "#1e0f3d", accent: "#ff4fd8", accent2: "#3ce8ff" },
  { id: "cyberpunk", name: "Киберпанк", bg: "#06060a", surface: "#14141c", accent: "#f5f03c", accent2: "#ff2e88" },
  { id: "deco", name: "Ар-деко", bg: "#0b0a08", surface: "#1a1712", accent: "#c9a54c", accent2: "#e8cf8a" },
  { id: "retro80", name: "Ретро 80-е", bg: "#0b0e2a", surface: "#1a1f4a", accent: "#ff7a1a", accent2: "#16e0d0" },
  { id: "retro90", name: "Ретро 90-е", bg: "#006e6e", surface: "#101870", accent: "#ffe85c", accent2: "#c0c0c0" },
  { id: "popart", name: "Поп-арт", bg: "#143a96", surface: "#0e2262", accent: "#ffd600", accent2: "#ff2d3c" },
  { id: "constructivism", name: "Конструктивизм", bg: "#181412", surface: "#28221e", accent: "#d7261e", accent2: "#efe4cc" },
  { id: "matrix", name: "Матрица", bg: "#000602", surface: "#04140a", accent: "#00ff41", accent2: "#c8ffd2" },
  { id: "stickerbook", name: "Стикербук", bg: "#2a2438", surface: "#3a3250", accent: "#ff6fa5", accent2: "#5fd3c4" },
  { id: "pocketpet", name: "Тамагочи", bg: "#f3c6dc", surface: "#b9c9a0", accent: "#2f3a24", accent2: "#8fd3e8" },
  { id: "odyssey", name: "Одиссея", bg: "#eef1f4", surface: "#ffffff", accent: "#101318", accent2: "#e21e16", id: "mult", name: "Мультфильм", bg: "#f3e9d6", surface: "#fffaf0", accent: "#c4532f", accent2: "#6f9fb4", id: "tarkovsky", name: "Созерцание", bg: "#141613", surface: "#22241f", accent: "#c8a46a", accent2: "#7f9a8c" },
  { id: "silent", name: "Немое кино", bg: "#0c0c0c", surface: "#1c1c1c", accent: "#f2f2f2", accent2: "#9a9a9a" },
  { id: "anderson", name: "Симметрия", bg: "#f6d6d6", surface: "#fbeee6", accent: "#d9a520", accent2: "#8fcfb8" },
  // Music-only: the classic Winamp 2 skin.
  { id: "winamp", name: "Winamp", bg: "#2b2b3d", surface: "#000000", accent: "#00e000", accent2: "#ffcc2e" },
  // Music-only: post-punk black and white, a pulsar ridge plot (Joy Division mood).
  { id: "pulsar", name: "Пульсар", bg: "#000000", surface: "#0c0c0c", accent: "#f2efe6", accent2: "#8a8a84" },
] as const;

export type DesignId = (typeof DESIGNS)[number]["id"];

const TV_KEY = "martytv.design";
const OWN_KEY = "mm.design";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

const valid = (v: string | null): v is DesignId => !!v && DESIGNS.some((d) => d.id === v);

/** The music-only choice ("" = follow Cineko). */
export function ownDesign(): DesignId | "" {
  const v = read(OWN_KEY);
  return valid(v) ? v : "";
}

export function tvDesign(): DesignId {
  const v = read(TV_KEY);
  return valid(v) ? v : "kinozal";
}

export function currentDesign(): DesignId {
  return ownDesign() || tvDesign();
}

export function applyDesign() {
  const d = currentDesign();
  const root = document.documentElement;
  for (const x of DESIGNS) root.classList.toggle(`design-${x.id}`, x.id === d);
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const sw = DESIGNS.find((x) => x.id === d)!;
  if (meta) meta.content = sw.bg;
}

export function setOwnDesign(d: DesignId | "") {
  try {
    if (d) localStorage.setItem(OWN_KEY, d);
    else localStorage.removeItem(OWN_KEY);
  } catch {
    /* private mode */
  }
  applyDesign();
}

/** Apply now and follow changes made in Cineko (other tabs). */
export function initDesign() {
  applyDesign();
  window.addEventListener("storage", (e) => {
    if (e.key === TV_KEY || e.key === OWN_KEY) applyDesign();
  });
}

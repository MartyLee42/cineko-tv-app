// Profile settings (server, per viewing profile) and the theme cache.
import type { ProfileSettings } from "@martytv/contracts";
import { applyDesign, applyTheme, designHasLight, DESIGNS, type DesignSetting, type ThemeSetting } from "@martytv/ui";

export type Settings = ProfileSettings;
/** Partial update (PUT accepts omitted fields). */
export type SettingsPatch = Partial<ProfileSettings>;
export type LoadingStyle = Settings["loading_style"];

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  design: "kinozal",
  design_surprise: "off",
  design_favorites: [],
  hide_anime: false,
  hide_watched: false,
  autoplay_next_episode: true,
  autoplay_countdown: true,
  skip_segments: "button",
  spoiler_free_episodes: false,
  onboarding_completed: false,
  loading_style: "popcorn",
  poster_rating: "kp",
  sources: { enabled: "all" },
  taste_note: "",
  min_votes: 100,
  video_quality: 720,
  video_hide_shorts: true,
  video_autoplay: true,
  seasonal_effects: "off",
  hidden_tabs: [],
  cozy_mode: false,
  cozy_ambience: "fireplace",
  cozy_sound: false,
  poster_wobble: true,
  share_with_family: false,
  show_family: true,
  show_curated: true,
  film_theme: false,
};

export const LOADING_STYLES: LoadingStyle[] = ["popcorn", "fill_title", "poster_reveal", "film_reel", "minimal", "marty", "marty_popcorn", "matrix",
  "water_glass", "poster_dig", "chocolate_box", "coffee_cup", "honey_pot", "hyperjump", "ghost_meter", "target_scan", "docking", "claw_machine",
];
export const THEMES: ThemeSetting[] = ["system", "dark", "light"];

/** Fills defaults for anything the server omitted, then applies a partial patch. */
export function mergeSettings(base: SettingsPatch | undefined, patch: SettingsPatch = {}): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  for (const src of [base ?? {}, patch]) {
    for (const [k, v] of Object.entries(src) as [keyof Settings, unknown][]) {
      if (v !== undefined && v !== null) (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/** Fields whose change alters «Для вас» / Explore (server-side rebuild). */
export function affectsForYou(patch: SettingsPatch): boolean {
  return patch.min_votes !== undefined || patch.hide_anime !== undefined || patch.show_family !== undefined || patch.show_curated !== undefined;
}

/** Fields whose change alters catalog results (server-side filtering). */
export function affectsCatalog(patch: SettingsPatch): boolean {
  return patch.hide_anime !== undefined || patch.hide_watched !== undefined;
}

// ---------------------------------------------------------------- theme & design

const THEME_KEY = "martytv.theme";
const DESIGN_KEY = "martytv.design";

export function parseTheme(v: string | null | undefined): ThemeSetting {
  return v === "dark" || v === "light" || v === "system" ? v : "system";
}
export function parseDesign(v: string | null | undefined): DesignSetting {
  return DESIGNS.includes(v as DesignSetting) ? (v as DesignSetting) : "kinozal";
}
/** Only Кинозал has a light variant; every other design is dark-only. */
export function supportsLight(design: DesignSetting): boolean {
  return designHasLight(design);
}

export interface Look {
  theme: ThemeSetting;
  design: DesignSetting;
}

export function readCachedLook(): Look {
  try {
    return { theme: parseTheme(localStorage.getItem(THEME_KEY)), design: parseDesign(localStorage.getItem(DESIGN_KEY)) };
  } catch {
    return { theme: "system", design: "kinozal" };
  }
}

function cacheLook(look: Look) {
  try {
    localStorage.setItem(THEME_KEY, look.theme);
    localStorage.setItem(DESIGN_KEY, look.design);
  } catch {
    // private mode
  }
}

let cleanup: (() => void) | null = null;
let current: Look | null = null;

/** Applies design + theme to <html> (idempotent) and remembers them for the next load. */
export function setLook(patch: Partial<Look>) {
  const look: Look = { ...(current ?? readCachedLook()), ...patch };
  cacheLook(look);
  if (current && current.theme === look.theme && current.design === look.design) return;
  const themeChanged = current?.theme !== look.theme;
  current = look;
  applyDesign(look.design);
  if (themeChanged) {
    cleanup?.();
    cleanup = applyTheme(look.theme);
  }
}

/**
 * Keeps <meta name="theme-color"> (status bar / installed PWA chrome) equal to
 * the current page background, whatever changed it (design, theme, "system").
 */
export function syncThemeColorMeta() {
  const root = document.documentElement;
  const update = () => {
    const rgb = getComputedStyle(root).getPropertyValue("--mt-bg").trim();
    if (!rgb) return;
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", `rgb(${rgb})`));
  };
  update();
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(update).observe(root, { attributes: true, attributeFilter: ["class"] });
  }
}

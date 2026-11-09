// The active profile and its server-side settings (theme, hide anime/watched,
// autoplay, spoiler-free, loading animation). Settings live in the React
// Query cache under settingsKey(profile); non-React code (the player) reads
// them synchronously through currentSettings().
import { useMutation, useQuery } from "@tanstack/react-query";
import { unwrap, type ProfileSettings, type Schemas } from "@martytv/contracts";
import { DESIGNS as UI_DESIGNS, effectiveDesign } from "@martytv/ui";
import { api } from "../api";
import { queryClient } from "../catalog/queries";
import { storage } from "../platform";
import { DESIGN_KEY, SEEDED_KEY, startDesign } from "../design/newTv";
import { activeProfile, useActiveProfileId } from "./active";

export { activeProfile, useActiveProfileId };

export type LoadingStyle = NonNullable<ProfileSettings["loading_style"]>;
export type ThemeSetting = NonNullable<ProfileSettings["theme"]>;
export type DesignSetting = NonNullable<ProfileSettings["design"]>;
export type PosterRatingSetting = NonNullable<ProfileSettings["poster_rating"]>;
export const POSTER_RATINGS: readonly PosterRatingSetting[] = ["kp", "tmdb", "imdb", "off"];
/** Every design (the registry in @martytv/ui, same order as the contract enum). */
export const DESIGNS: readonly DesignSetting[] = UI_DESIGNS;
export type Settings = Required<ProfileSettings>;
const MIN_VOTES: readonly Settings["min_votes"][] = [0, 50, 100, 300, 1000, 5000];

export const LOADING_STYLES: readonly LoadingStyle[] = ["popcorn", "fill_title", "poster_reveal", "film_reel", "minimal", "marty", "marty_popcorn", "matrix", "paws", "aquarium", "speed88", "odyssey", "balloons", "catch", "water_glass", "poster_dig", "chocolate_box", "coffee_cup", "honey_pot", "hyperjump", "ghost_meter", "target_scan", "docking", "claw_machine", "surprise", "match"];
export const THEMES: readonly ThemeSetting[] = ["system", "dark", "light"];

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  sources: { enabled: "all" },
  hide_anime: false,
  hide_watched: false,
  autoplay_next_episode: true,
  autoplay_countdown: true,
  skip_segments: "button",
  spoiler_free_episodes: false,
  loading_style: "popcorn",
  onboarding_completed: false,
  design: "wireframe",
  design_surprise: "off",
  design_favorites: [],
  poster_rating: "kp",
  taste_note: "",
  min_votes: 100,
  iptv_playlists: "all",
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

/** Server settings with defaults filled in (unknown enum values fall back). */
export function withDefaults(s: ProfileSettings | null | undefined): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (!s) return out;
  if (s.theme && THEMES.includes(s.theme)) out.theme = s.theme;
  if (s.loading_style && LOADING_STYLES.includes(s.loading_style)) out.loading_style = s.loading_style;
  if (s.design && DESIGNS.includes(s.design)) out.design = s.design;
  if (s.design_surprise === "off" || s.design_surprise === "day" || s.design_surprise === "week") out.design_surprise = s.design_surprise;
  if (Array.isArray(s.design_favorites)) out.design_favorites = DESIGNS.filter((d) => s.design_favorites!.includes(d));
  if (s.poster_rating && POSTER_RATINGS.includes(s.poster_rating)) out.poster_rating = s.poster_rating;
  if (typeof s.taste_note === "string") out.taste_note = s.taste_note;
  if (s.min_votes !== undefined && MIN_VOTES.includes(s.min_votes)) out.min_votes = s.min_votes;
  if (s.seasonal_effects === "on" || s.seasonal_effects === "calm" || s.seasonal_effects === "off") out.seasonal_effects = s.seasonal_effects;
  if (Array.isArray(s.hidden_tabs)) out.hidden_tabs = s.hidden_tabs;
  if (s.cozy_ambience === "rain" || s.cozy_ambience === "fireplace" || s.cozy_ambience === "off") out.cozy_ambience = s.cozy_ambience;
  if (s.skip_segments === "button" || s.skip_segments === "auto" || s.skip_segments === "off") out.skip_segments = s.skip_segments;
  if (s.video_quality === 480 || s.video_quality === 720 || s.video_quality === 1080) out.video_quality = s.video_quality;
  for (const k of ["hide_anime", "hide_watched", "autoplay_next_episode", "autoplay_countdown", "spoiler_free_episodes", "onboarding_completed", "video_hide_shorts", "video_autoplay", "cozy_mode", "cozy_sound", "poster_wobble", "share_with_family", "show_family", "show_curated", "film_theme"] as const) {
    if (typeof s[k] === "boolean") out[k] = s[k];
  }
  return out;
}

// ---------------------------------------------------------------- settings

export const settingsKey = (profileId: string | null) => ["profile-settings", profileId] as const;

/** Last theme/design applied on this TV (so the next start doesn't flash the wrong one). */
const THEME_KEY = "martytv.theme";
/** The last profile's «Сюрприз» inputs: the next start (intro, first chunk) shows today's pick, not yesterday's. */
const SURPRISE_KEY = "martytv.design_surprise";
interface CachedSurprise {
  p: string;
  d: DesignSetting;
  m: Settings["design_surprise"];
  f: string[];
}
export const themeCache = {
  get(): ThemeSetting {
    const v = storage.get(THEME_KEY);
    return v && (THEMES as readonly string[]).includes(v) ? (v as ThemeSetting) : "dark";
  },
  set: (v: ThemeSetting) => storage.set(THEME_KEY, v),
  design(): DesignSetting {
    try {
      const c = JSON.parse(storage.get(SURPRISE_KEY) ?? "null") as CachedSurprise | null;
      if (c && (DESIGNS as readonly string[]).includes(c.d)) return effectiveDesign({ design: c.d, design_surprise: c.m, design_favorites: c.f }, c.p);
    } catch {
      /* garbled: the plain cache below */
    }
    const v = startDesign(storage.get(DESIGN_KEY));
    return (DESIGNS as readonly string[]).includes(v) ? (v as DesignSetting) : "wireframe";
  },
  /** Remembers the shown design (index.html paints its background) and the surprise inputs behind it. */
  setDesign: (v: DesignSetting, s?: Settings, profileId?: string | null) => {
    storage.set(DESIGN_KEY, v);
    storage.remove(SEEDED_KEY); // a profile's own design from now on
    if (s && profileId && s.design_surprise !== "off") {
      const c: CachedSurprise = { p: profileId, d: s.design, m: s.design_surprise, f: s.design_favorites };
      storage.set(SURPRISE_KEY, JSON.stringify(c));
    } else storage.remove(SURPRISE_KEY);
  },
};

function fetchSettings(id: string): Promise<Settings> {
  return unwrap(api.GET("/profiles/{id}/settings", { params: { path: { id } } })).then(withDefaults);
}

/** Settings of the active profile (defaults while loading or if the API fails). */
export function useSettings(): Settings {
  return useLoadedSettings() ?? DEFAULT_SETTINGS;
}

/** Settings of the active profile once loaded (undefined before / without a profile). */
export function useLoadedSettings(): Settings | undefined {
  const q = useSettingsQuery();
  return q.data ?? (q.isError ? DEFAULT_SETTINGS : undefined);
}

/** The raw query (`data` only when the server answered). */
export function useSettingsQuery() {
  const id = useActiveProfileId();
  return useQuery({
    queryKey: settingsKey(id),
    enabled: !!id,
    queryFn: () => fetchSettings(id!),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/** Synchronous read for non-React code. */
export function currentSettings(): Settings {
  return queryClient.getQueryData<Settings>(settingsKey(activeProfile.get())) ?? DEFAULT_SETTINGS;
}

/** Fields that change catalog contents: lists are refetched when they change. */
const CATALOG_FIELDS: readonly (keyof Settings)[] = ["hide_anime", "hide_watched", "min_votes"];

export function affectsCatalog(patch: Partial<Settings>): boolean {
  return CATALOG_FIELDS.some((k) => k in patch);
}

/**
 * Saves a partial update: applied to the cache at once (optimistic), rolled
 * back if the server refuses, and replaced by the server's answer.
 */
/** The newest save per profile: older answers must not overwrite a newer optimistic value. */
const latestSave = new Map<string, number>();
let saveSeq = 0;

export function useSaveSettings() {
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Settings> }) =>
      // The API takes partial updates (the generated type marks defaulted fields required).
      unwrap(api.PUT("/profiles/{id}/settings", { params: { path: { id } }, body: patch as Settings })).then(withDefaults),
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: settingsKey(id) });
      const prev = queryClient.getQueryData<Settings>(settingsKey(id));
      queryClient.setQueryData<Settings>(settingsKey(id), applyPatch(prev, patch));
      const seq = ++saveSeq;
      latestSave.set(id, seq);
      return { prev, seq };
    },
    onError: (_e, { id }, c) => {
      // Roll back only if nothing newer was changed meanwhile.
      if (latestSave.get(id) === c?.seq) queryClient.setQueryData(settingsKey(id), c?.prev ?? DEFAULT_SETTINGS);
    },
    onSuccess: (saved, { id }, c) => {
      // Quick presses (Right, Right…): an older answer would flip the value
      // back for a moment (the loader preview restarted twice).
      if (latestSave.get(id) === c?.seq) queryClient.setQueryData(settingsKey(id), saved);
    },
    onSettled: (_d, _e, { patch }) => {
      // «Семья советует» / «Подборка» rows (in «Для вас») and family ratings in Details.
      if ("show_family" in patch || "show_curated" in patch) {
        void queryClient.invalidateQueries({ queryKey: ["foryou"] });
        void queryClient.invalidateQueries({ queryKey: ["family"] });
      }
      if (!affectsCatalog(patch)) return;
      void queryClient.invalidateQueries({ queryKey: ["catalog"] });
      void queryClient.invalidateQueries({ queryKey: ["related"] });
      // «Для вас» / Explore follow min_votes (rows rebuild on the server).
      void queryClient.invalidateQueries({ queryKey: ["foryou"] });
    },
  });
}

export function applyPatch(prev: Settings | undefined, patch: Partial<Settings>): Settings {
  return { ...(prev ?? DEFAULT_SETTINGS), ...patch };
}

/**
 * The profile's playback preferences (voice-overs, audio languages). The TV
 * reads them with its device credential (read-only; they're edited on the
 * phone). Cached for a minute; resolves null on any failure so the player
 * falls back to the file's default track.
 */
const prefsCache = new Map<string, { at: number; value: Schemas["Preferences"] }>();
export function loadPreferences(id: string): Promise<Schemas["Preferences"] | null> {
  const hit = prefsCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return Promise.resolve(hit.value);
  return unwrap(api.GET("/profiles/{id}/preferences", { params: { path: { id } } }))
    .then((value) => {
      prefsCache.set(id, { at: Date.now(), value });
      return value;
    })
    .catch(() => null);
}

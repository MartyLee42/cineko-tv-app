// Holiday animations in the PWA: decides from the profile's seasonal_effects,
// the admin switch (GET /status), reduced motion, playback and the route
// whether to draw the shared SeasonLayer. Mounted once in Layout; the
// full-screen player (/watch) is outside Layout, inline players pause it
// through useVideoPlaying, and title pages (trailers, backdrops) skip it.
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { isAdminRole, unwrap } from "@martytv/contracts";
import {
  forcedState,
  SeasonLayer,
  seasonParam,
  seasonRender,
  useReducedMotion,
  useSeasonPreview,
  useTodaySeasonState,
  useVideoPlaying,
  type SeasonRender,
  type SeasonState,
} from "@martytv/ui";
import { api } from "../api";
import { useSession } from "../session";
import { useSettings } from "../watch/queries";

/** GET /status (shared with anything else that reads it): the admin's seasonal switch. */
export function useSeasonalAllowed(): boolean {
  const q = useQuery({ queryKey: ["service-status"], queryFn: () => unwrap(api.GET("/status")), staleTime: 60_000, refetchInterval: 5 * 60_000, retry: false });
  return q.data?.seasonal_effects !== false;
}

export function useNarrow(): boolean {
  const q = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 767px)") : null;
  const [n, setN] = useState(() => !!q?.matches);
  useEffect(() => {
    if (!q) return;
    const f = () => setN(q.matches);
    q.addEventListener("change", f);
    return () => q.removeEventListener("change", f);
  }, [q]);
  return n;
}

/** Routes where decorations would distract (title page: trailer, backdrop, long text). */
export function suppressedRoute(pathname: string): boolean {
  return /^\/title\//.test(pathname);
}

export function useWebSeason(): { state: SeasonState | null; render: SeasonRender; preview: boolean } {
  const settings = useSettings();
  const allowed = useSeasonalAllowed();
  const reduced = useReducedMotion();
  const playing = useVideoPlaying();
  const { pathname, search } = useLocation();
  const { data: session } = useSession();
  const today = useTodaySeasonState();
  const preview = useSeasonPreview();
  // ?season=<id> (QA): dev builds, or admins in production.
  const param = seasonParam(search);
  const forced = param && (import.meta.env.DEV || isAdminRole(session?.user.role)) ? param : null;
  const state = preview ? forcedState(preview, new Date()) : forced === "off" ? null : forced ? forcedState(forced, new Date()) : today;
  const render = seasonRender({
    season: state?.id ?? null,
    setting: settings.seasonal_effects,
    adminEnabled: allowed,
    reducedMotion: reduced,
    playing,
    suppressed: !preview && suppressedRoute(pathname),
    preview: !!preview,
  });
  return { state, render, preview: !!preview };
}

export function WebSeasonLayer() {
  const { state, render, preview } = useWebSeason();
  const narrow = useNarrow();
  if (!state || render === "none") return null;
  return (
    <SeasonLayer
      key={`${state.id}${preview ? "-preview" : ""}`}
      season={state.id}
      mode={render}
      platform="web"
      narrow={narrow}
      preview={preview}
      intensity={state.intensity}
      main={state.main}
      greeting={preview ? null : { phase: state.main ? "day" : "soon", year: state.year }}
    />
  );
}

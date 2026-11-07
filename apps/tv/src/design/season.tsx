// Holiday animations on the TV: decides from the profile's seasonal_effects,
// the admin switch (GET /status), this TV's calm motion, reduced motion and
// playback whether Home & co. draw the shared SeasonLayer, and how.
// CatalogShell mounts <TvSeasonLayer/> only on menu screens (never on
// Details, Settings, the guide or while the player / live TV replaces the
// catalog), so it is absent during playback by construction.
import { lazy, Suspense, useEffect, useState } from "react";
import { isAdminRole, unwrap } from "@martytv/contracts";
import {
  forcedState,
  seasonParam,
  seasonRender,
  useReducedMotion,
  useTodaySeasonState,
  useVideoPlaying,
  type SeasonId,
  type SeasonRender,
  type SeasonState,
} from "@martytv/ui";
import { api } from "../api";
import { useSettings } from "../profile/settings";
import { useServerStatus } from "./data";
import { useCalmMotion } from "./skins";

// The layer (and its sprites) is its own chunk: fetched only when a holiday is on.
const SeasonLayer = lazy(() => import("@martytv/ui/season-layer").then((m) => ({ default: m.SeasonLayer })));

/** Today's season id (Settings' preview starts there). */
export function useTodaySeason(): SeasonId | null {
  return useTodaySeasonState()?.id ?? null;
}

/** `?season=<id>` (QA): honoured in dev builds, else only when this TV's owner is an admin. */
function useForcedSeason(): SeasonId | "off" | null {
  const param = typeof location !== "undefined" ? seasonParam(location.search) : null;
  const [allowed, setAllowed] = useState(() => import.meta.env.DEV);
  useEffect(() => {
    if (!param || allowed) return;
    let live = true;
    void unwrap(api.GET("/auth/session"))
      .then((s) => live && setAllowed(isAdminRole(s.user.role)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [param, allowed]);
  return allowed ? param : null;
}

/** The season state and how to draw it here and now. */
export function useTvSeason(suppressed = false): { state: SeasonState | null; render: SeasonRender } {
  const settings = useSettings();
  const status = useServerStatus();
  const calm = useCalmMotion();
  const reduced = useReducedMotion();
  const playing = useVideoPlaying();
  const today = useTodaySeasonState();
  const forced = useForcedSeason();
  const state = forced === "off" ? null : forced ? forcedState(forced, new Date()) : today;
  const render = seasonRender({
    season: state?.id ?? null,
    setting: settings.seasonal_effects,
    adminEnabled: status.data?.seasonal_effects !== false,
    reducedMotion: reduced,
    calmMotion: calm,
    playing,
    suppressed,
  });
  return { state, render };
}

/** The live layer on the catalog's menu screens (with the once-per-season greeting). */
export function TvSeasonLayer() {
  const { state, render } = useTvSeason();
  if (!state || render === "none") return null;
  return (
    <Suspense fallback={null}>
    <SeasonLayer
      season={state.id}
      mode={render}
      platform="tv"
      intensity={state.intensity}
      main={state.main}
      greeting={{ phase: state.main ? "day" : "soon", year: state.year }}
      fixed={false}
    />
    </Suspense>
  );
}

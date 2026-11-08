// This TV's own options (every profile): screensaver, UI sounds, startup
// intro, calm motion, language, health reports and the player hints. They
// live on the server (GET/PATCH /devices/me/settings) so a phone can change
// them (Устройства → the TV → «Настройки»); localStorage stays the cache each
// feature reads, so the TV starts instantly and works offline. The first
// sync uploads the values this TV already had (seedPatch).
import { useEffect, useSyncExternalStore } from "react";
import { unwrap } from "@martytv/contracts";
import { seedPatch, uiSoundsPref, useI18n, type Locale, type TvOwnKey, type TvOwnSettings } from "@martytv/ui";
import { api } from "../api";
import { calmMotion } from "../design/skins";
import { healthPref } from "../health/agent";
import { saverPref } from "../idle/logic";
import { introPref } from "../intro/logic";
import { prebufferPref, slowHintPref } from "../player/rebuffer";
import { useActiveProfileId } from "../profile/active";
import { loadPreferences } from "../profile/settings";
import { speedtest } from "./speedtest";

type Language = NonNullable<TvOwnSettings["language"]>;
let language: { get: () => Language | undefined; set: (l: Language) => void } | null = null;

/** The local stores behind each option. */
const STORES: { [K in TvOwnKey]-?: { get: () => TvOwnSettings[K] | undefined; set: (v: NonNullable<TvOwnSettings[K]>) => void } } = {
  screensaver: { get: () => saverPref.get(), set: (v) => saverPref.set(v) },
  ui_sounds: { get: () => uiSoundsPref.get(), set: (v) => uiSoundsPref.set(v) },
  startup_intro: { get: () => introPref.get(), set: (v) => introPref.set(v) },
  calm_motion: { get: () => calmMotion.get(), set: (v) => calmMotion.set(v) },
  language: { get: () => language?.get(), set: (v) => language?.set(v) },
  health_report: { get: () => healthPref.get(), set: (v) => healthPref.set(v) },
  slow_hint: { get: () => slowHintPref.get(), set: (v) => slowHintPref.set(v) },
  show_prebuffer: { get: () => prebufferPref.get(), set: (v) => prebufferPref.set(v) },
  speedtest: { get: () => speedtest.enabled(), set: (v) => speedtest.setEnabled(v) },
};
const KEYS = Object.keys(STORES) as TvOwnKey[];

const listeners = new Set<() => void>();
let version = 0;
const bump = () => {
  version++;
  listeners.forEach((l) => l());
};

function readLocal(): TvOwnSettings {
  const out: Record<string, unknown> = {};
  for (const k of KEYS) {
    const v = STORES[k].get();
    if (v !== undefined) out[k] = v;
  }
  return out as TvOwnSettings;
}

/** Writes server values into the local stores (only what differs). */
function applyLocal(s: TvOwnSettings) {
  let changed = false;
  for (const k of KEYS) {
    const v = s[k];
    if (v === undefined || v === null || STORES[k].get() === v) continue;
    (STORES[k].set as (x: unknown) => void)(v);
    changed = true;
  }
  if (changed) bump();
}

let inflight: Promise<void> | null = null;

export const tvOwn = {
  /** Fetches the server copy, seeds what it lacks, applies the rest. Quiet on failure. */
  sync(): Promise<void> {
    inflight ??= (async () => {
      try {
        const v = await unwrap(api.GET("/devices/{id}/settings", { params: { path: { id: "me" } } }));
        const seed = seedPatch(v.device, readLocal());
        if (Object.keys(seed).length > 0) await unwrap(api.PATCH("/devices/{id}/settings", { params: { path: { id: "me" } }, body: { device: seed } }));
        applyLocal(v.device);
      } catch {
        // offline: the local values stay
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },
  /** Changes an option here (TV Settings): at once locally, then on the server. */
  set<K extends TvOwnKey>(key: K, value: NonNullable<TvOwnSettings[K]>) {
    (STORES[key].set as (x: unknown) => void)(value);
    bump();
    void unwrap(api.PATCH("/devices/{id}/settings", { params: { path: { id: "me" } }, body: { device: { [key]: value } } })).catch(() => undefined);
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  version: () => version,
};

/** React: re-renders when an option changes (here or from a phone). */
export function useTvOwnVersion(): number {
  return useSyncExternalStore(tvOwn.subscribe, tvOwn.version);
}

/**
 * Connects the language option to the i18n provider (mount once, in App).
 * The option is this TV's own pick only (never the detected language, so a
 * new TV doesn't upload one): without it the TV shows the active profile's
 * ui_language, else its own language.
 */
export function useTvOwnLanguage() {
  const { deviceLocale, setLocale, setProfileLocale } = useI18n();
  useEffect(() => {
    language = { get: () => deviceLocale ?? undefined, set: (l) => setLocale(l as Locale) };
  }, [deviceLocale, setLocale]);
  const profileId = useActiveProfileId();
  useEffect(() => {
    if (!profileId) return;
    let live = true;
    void loadPreferences(profileId).then((p) => {
      if (live && p) setProfileLocale(p.ui_language);
    });
    return () => {
      live = false;
    };
  }, [profileId, setProfileLocale]);
}

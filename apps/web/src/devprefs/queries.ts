// Playback profile API: this browser's record (/me/playback-clients/{id}),
// TVs (/devices/{id}/playback-prefs), and the auto-report of what this
// browser detects (on app start, throttled, and after a playback session).
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError, unwrap, type Schemas } from "@martytv/contracts";
import type { PlaybackManual } from "@martytv/media-types";
import { api } from "../api";
import { compatUsable, decodableCodecs, thisBrowser } from "../play/browserSupport";
import {
  autoSignature,
  browserAuto,
  clientId,
  currentEstimate,
  readLastSync,
  recordSample,
  shouldSync,
  writeLastSync,
} from "./logic";

export type PlaybackPrefs = Schemas["PlaybackPrefs"];
export type ClientPrefs = Schemas["ClientPlaybackPrefs"];
type Auto = Schemas["PlaybackAuto"];
type Manual = Schemas["PlaybackManual"];

export const clientPrefsKey = (id: string) => ["playback-client", id] as const;
export const devicePrefsKey = (id: string) => ["devices", id, "playback-prefs"] as const;
export const CLIENTS_KEY = ["playback-clients"] as const;

// ---------------------------------------------------------------- this browser

/** What this browser detects about itself right now. */
export function detectHere(): Auto {
  const { probe, env } = thisBrowser();
  const hdr = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(dynamic-range: high)").matches;
  const nav = typeof navigator !== "undefined" ? navigator : null;
  const scr = typeof screen !== "undefined" ? screen : null;
  return browserAuto({
    ua: nav?.userAgent ?? "",
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    screen: scr ? { width: scr.width, height: scr.height, dpr: typeof devicePixelRatio === "number" ? devicePixelRatio : 1 } : null,
    decodable: decodableCodecs(probe, env, hdr),
    compat: compatUsable(),
    throughput: currentEstimate(),
  }) as Auto;
}

let inflight: Promise<ClientPrefs | null> | null = null;

/**
 * Upserts this browser's auto record when it changed or every 12 h (`force`:
 * after a playback session). Failures are silent (an older API without the
 * endpoint, offline…): ranking just has no browser profile then.
 */
export function syncClient(qc: QueryClient, userId: string, opts: { force?: boolean } = {}): Promise<ClientPrefs | null> {
  if (inflight) return inflight;
  const auto = detectHere();
  const sig = autoSignature(auto);
  const now = Date.now();
  if (!shouldSync(readLastSync(userId), sig, now, opts.force)) return Promise.resolve(null);
  const id = clientId();
  inflight = unwrap(
    api.PATCH("/me/playback-clients/{client_id}", {
      params: { path: { client_id: id } },
      body: { auto: { ...auto, detected_at: new Date(now).toISOString() }, name: (auto.model ?? "").slice(0, 64), platform: auto.platform ?? "" },
    }),
  )
    .then((rec) => {
      writeLastSync(userId, { at: now, sig });
      qc.setQueryData(clientPrefsKey(id), rec);
      void qc.invalidateQueries({ queryKey: CLIENTS_KEY });
      return rec;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** End of a web playback session: store its throughput sample and re-report. */
export function recordSessionThroughput(qc: QueryClient, bps: number | null): void {
  if (bps != null) recordSample(bps);
  const userId = qc.getQueryData<Schemas["Session"] | null>(["session"])?.user.id;
  if (userId) void syncClient(qc, userId, { force: bps != null });
}

/** This browser's record (null when it was never saved). */
export function useClientPrefs() {
  const id = clientId();
  return useQuery({
    queryKey: clientPrefsKey(id),
    queryFn: async (): Promise<ClientPrefs | null> => {
      try {
        return await unwrap(api.GET("/me/playback-clients/{client_id}", { params: { path: { client_id: id } } }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

/** Saves this browser's manual values (auto is sent along when the record is new). */
export function useSaveClientManual() {
  const qc = useQueryClient();
  const id = clientId();
  return useMutation({
    mutationFn: (manual: PlaybackManual) => {
      const cur = qc.getQueryData<ClientPrefs | null>(clientPrefsKey(id));
      const auto = cur ? undefined : detectHere();
      return unwrap(
        api.PATCH("/me/playback-clients/{client_id}", {
          params: { path: { client_id: id } },
          body: {
            manual: manual as Manual,
            ...(auto && { auto, name: (auto.model ?? "").slice(0, 64), platform: auto.platform ?? "" }),
          },
        }),
      );
    },
    onSuccess: (rec) => {
      qc.setQueryData(clientPrefsKey(id), rec);
      void qc.invalidateQueries({ queryKey: CLIENTS_KEY });
      void qc.invalidateQueries({ queryKey: ["releases"] });
    },
  });
}

/** The user's browsers with a playback profile. */
export function usePlaybackClients(enabled = true) {
  return useQuery({
    queryKey: CLIENTS_KEY,
    queryFn: async () => (await unwrap(api.GET("/me/playback-clients"))).items,
    enabled,
    retry: false,
  });
}

export function useForgetClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/me/playback-clients/{client_id}", { params: { path: { client_id: id } } })),
    onSettled: () => void qc.invalidateQueries({ queryKey: CLIENTS_KEY }),
  });
}

// ---------------------------------------------------------------- TVs

export function useDevicePrefs(deviceId: string, enabled = true) {
  return useQuery({
    queryKey: devicePrefsKey(deviceId),
    queryFn: () => unwrap(api.GET("/devices/{id}/playback-prefs", { params: { path: { id: deviceId } } })),
    retry: false,
    enabled: enabled && !!deviceId,
  });
}

/** Saves a TV's manual values (its auto part is the TV's own report: not sent). */
export function useSaveDeviceManual(deviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (manual: PlaybackManual) =>
      unwrap(api.PATCH("/devices/{id}/playback-prefs", { params: { path: { id: deviceId } }, body: { manual: manual as Manual } })),
    onSuccess: (p) => {
      qc.setQueryData(devicePrefsKey(deviceId), p);
      // Release ranking for this TV changes.
      void qc.invalidateQueries({ queryKey: ["releases"] });
    },
  });
}

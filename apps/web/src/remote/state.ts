// Live device state: seeded over HTTP, then kept current by realtime events.
import { useEffect, useSyncExternalStore } from "react";
import { useQueries, useQuery, type QueryClient } from "@tanstack/react-query";
import {
  ApiError,
  CommandError,
  newId,
  unwrap,
  type AckPayload,
  type CommandPayloads,
  type Device,
  type DeviceState,
  type Envelope,
} from "@martytv/contracts";
import { api, realtime } from "../api";
import { stateFromResult } from "./logic";

export interface LiveState {
  online: boolean;
  state: DeviceState | null;
}

/** Not under ["devices"], so invalidating the device list doesn't refetch every state. */
export const stateKey = (id: string) => ["device-state", id] as const;

const fetchState = (id: string) => (): Promise<LiveState> =>
  unwrap(api.GET("/devices/{id}/state", { params: { path: { id } } })).catch((e: unknown) => {
    // Fallback: ask over the socket; the device.state event fills the cache.
    if (realtime.state === "open") realtime.command(id, "device.request_state").catch(() => {});
    throw e;
  });

const stateQuery = (id: string) => ({
  queryKey: stateKey(id),
  queryFn: fetchState(id),
  // Events keep it fresh; it's refetched on reconnect (see applyRealtime).
  staleTime: Infinity,
  refetchOnWindowFocus: false,
});

export function useDeviceState(id: string | undefined) {
  return useQuery({ ...stateQuery(id ?? ""), enabled: !!id });
}

/** State per visible device, keyed by id. `online` falls back to the device list. */
export function useDeviceStates(devices: Device[] | undefined): Record<string, LiveState> {
  return useQueries({
    queries: (devices ?? []).map((d) => stateQuery(d.id)),
    combine: (results) => {
      const out: Record<string, LiveState> = {};
      (devices ?? []).forEach((d, i) => {
        const r = results[i]?.data;
        out[d.id] = { online: r?.online ?? d.online, state: r?.state ?? null };
      });
      return out;
    },
  });
}

function patchState(qc: QueryClient, id: string, patch: Partial<LiveState>) {
  qc.setQueryData<LiveState>(stateKey(id), (old) => ({ online: true, state: null, ...old, ...patch }));
}

function patchDeviceOnline(qc: QueryClient, id: string, online: boolean) {
  qc.setQueryData<Device[]>(["devices"], (list) => list?.map((d) => (d.id === id ? { ...d, online } : d)));
}

/** Applies one realtime envelope to the query cache. */
export function applyRealtime(qc: QueryClient, env: Envelope) {
  const id = env.device_id;
  switch (env.type) {
    case "device.state":
      if (id && env.payload) patchState(qc, id, { online: true, state: env.payload as DeviceState });
      break;
    case "device.presence": {
      const online = !!(env.payload as { online?: boolean } | undefined)?.online;
      if (id) {
        patchState(qc, id, { online });
        patchDeviceOnline(qc, id, online);
      }
      qc.invalidateQueries({ queryKey: ["devices"] });
      break;
    }
    case "device.changed":
      qc.invalidateQueries({ queryKey: ["devices"] });
      break;
  }
}

/**
 * Subscribes the cache to realtime events; after a reconnect, refetches
 * everything that may have changed while the socket was down.
 */
export function useRealtimeCache(qc: QueryClient, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let wasOpen = realtime.state === "open";
    const offMsg = realtime.on((env) => applyRealtime(qc, env));
    const offState = realtime.onState((s) => {
      if (s === "open" && !wasOpen) {
        qc.invalidateQueries({ queryKey: ["device-state"] });
        qc.invalidateQueries({ queryKey: ["devices"] });
      }
      wasOpen = s === "open";
    });
    return () => {
      offMsg();
      offState();
    };
  }, [qc, enabled]);
}

/**
 * Sends a command and resolves with the ack (throws CommandError/ApiError).
 * Prefers the open WebSocket; falls back to HTTP. Retries reuse `id`, so the
 * server never runs the same command twice.
 */
export async function sendCommand<K extends keyof CommandPayloads>(
  qc: QueryClient,
  deviceId: string,
  type: K,
  payload: CommandPayloads[K],
  id: string = newId(),
): Promise<AckPayload> {
  let ack: AckPayload;
  if (realtime.state === "open") {
    ack = await realtime.command(deviceId, type, payload, id);
  } else {
    ack = await postCommand(deviceId, type, payload, id).catch((e: unknown) => {
      if (e instanceof ApiError && (e.status === 0 || e.status >= 502)) return postCommand(deviceId, type, payload, id);
      throw e;
    });
    if (!ack.ok) throw new CommandError(ack.error ?? "failed");
  }
  const st = stateFromResult(ack.result);
  if (st) patchState(qc, deviceId, { online: true, state: st });
  return ack;
}

function postCommand(deviceId: string, type: keyof CommandPayloads, payload: unknown, id: string) {
  return unwrap(
    api.POST("/devices/{id}/commands", { params: { path: { id: deviceId } }, body: { id, type, payload } }),
  ) as Promise<AckPayload>;
}

// ---------------------------------------------------------------- last used TV

const LAST_KEY = "martytv.last_tv";
const lastListeners = new Set<() => void>();

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export function setLastUsedDevice(id: string) {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    // private mode: not remembered
  }
  lastListeners.forEach((l) => l());
}

export function useLastUsedDevice(): string | null {
  return useSyncExternalStore(
    (cb) => {
      lastListeners.add(cb);
      window.addEventListener("storage", cb);
      return () => {
        lastListeners.delete(cb);
        window.removeEventListener("storage", cb);
      };
    },
    readLast,
    () => null,
  );
}

// A TV's settings edited from the phone / computer (GET/PATCH
// /devices/{id}/settings): its own options and its layer of a profile's
// settings. Saves are optimistic; the TV applies them live (settings.changed).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap, type ProfileSettings, type Schemas } from "@martytv/contracts";
import { mergeLayers } from "@martytv/ui";
import { api } from "../api";

export type TvSettings = Schemas["TvSettings"];
export type TvOwn = Schemas["TvDeviceSettings"];
export type TvSettingsPatch = Schemas["TvSettingsPatch"];

export const tvSettingsKey = (deviceId: string, profileId: string | undefined) => ["tv-settings", deviceId, profileId ?? "auto"] as const;

export function useTvSettings(deviceId: string, profileId: string | undefined) {
  return useQuery({
    queryKey: tvSettingsKey(deviceId, profileId),
    queryFn: () =>
      unwrap(api.GET("/devices/{id}/settings", { params: { path: { id: deviceId }, query: profileId ? { profile_id: profileId } : {} } })),
    retry: (n, e) => (e as { status?: number }).status !== 404 && n < 2,
  });
}

/** The cached view after a patch (what the server will answer, for the optimistic update). */
export function applyTvPatch(v: TvSettings, patch: TvSettingsPatch): TvSettings {
  const device: Record<string, unknown> = { ...v.device, ...(patch.device ?? {}) };
  for (const k of patch.reset_device ?? []) delete device[k];
  if (!patch.profile && !patch.reset?.length) return { ...v, device: device as TvOwn };
  const over: Record<string, unknown> = { ...(v.overrides ?? {}), ...(patch.profile ?? {}) };
  for (const k of patch.reset ?? []) delete over[k];
  // A reset key goes back to the profile's value: unknown here, refetched after the save.
  const effective = v.effective ? mergeLayers(v.effective, patch.profile as Partial<ProfileSettings>) : v.effective;
  return { ...v, device: device as TvOwn, overrides: over as ProfileSettings, effective };
}

export function useSaveTvSettings(deviceId: string, profileId: string | undefined) {
  const qc = useQueryClient();
  const key = tvSettingsKey(deviceId, profileId);
  return useMutation({
    mutationFn: (patch: TvSettingsPatch) => unwrap(api.PATCH("/devices/{id}/settings", { params: { path: { id: deviceId } }, body: patch })),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<TvSettings>(key);
      if (prev) qc.setQueryData<TvSettings>(key, applyTvPatch(prev, patch));
      return { prev };
    },
    onError: (_e, _p, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (saved) => {
      qc.setQueryData(key, saved);
      // The TV's own options are the same for every profile.
      void qc.invalidateQueries({ queryKey: ["tv-settings", deviceId], predicate: (q) => q.queryKey[2] !== (profileId ?? "auto") });
    },
  });
}

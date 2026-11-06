// Active viewing profile on this phone/browser ("who is browsing").
import type { Profile } from "@martytv/contracts";

const keyFor = (userId: string) => `martytv.active_profile.${userId}`;

/**
 * The profile to browse as: the remembered one when it still exists, else the
 * first profile. Null when the account has no profiles.
 */
export function resolveActiveProfile(
  profiles: readonly Pick<Profile, "id">[] | undefined,
  storedId: string | null,
): string | null {
  if (!profiles?.length) return null;
  if (storedId && profiles.some((p) => p.id === storedId)) return storedId;
  return profiles[0]!.id;
}

export function readStoredProfile(userId: string): string | null {
  try {
    return localStorage.getItem(keyFor(userId));
  } catch {
    return null;
  }
}

export function storeProfile(userId: string, profileId: string) {
  try {
    localStorage.setItem(keyFor(userId), profileId);
  } catch {
    // private mode: remembered for this page only
  }
}

/**
 * Whether switching to `target` needs its PIN. The profile already active on
 * this browser was unlocked before (or was the default), so it doesn't.
 */
export function needsPin(target: Pick<Profile, "id" | "has_pin">, activeId: string | null): boolean {
  return target.has_pin && target.id !== activeId;
}

// A brand-new TV (nothing cached, not paired yet) starts in «Каркас»: the
// first frame (index.html, same rule), the pairing screen and the profile
// picker. The server gives TVs paired from now on the same default
// (NEW_TV_DESIGN, docs/architecture.md «Device settings»). A TV that has
// ever shown a profile has its design cached and keeps it.
import type { DesignSetting } from "@martytv/ui";

export const NEW_TV_DESIGN: DesignSetting = "wireframe";
export const DESIGN_KEY = "martytv.design";
const CREDENTIAL_KEY = "martytv.device_credential";

interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The design to show before any settings: the cached one, else «Каркас» on a fresh TV, else «Кинозал». */
export function startDesign(cached: string | null, paired: boolean): string {
  return cached || (paired ? "kinozal" : NEW_TV_DESIGN);
}

/** main.tsx: remember «Каркас» on a fresh TV, so it stays through pairing until a profile's settings arrive. */
export function seedNewTvDesign(kv: KV | null = safeLocalStorage()): void {
  if (!kv) return;
  try {
    if (!kv.getItem(DESIGN_KEY) && !kv.getItem(CREDENTIAL_KEY)) kv.setItem(DESIGN_KEY, NEW_TV_DESIGN);
  } catch {
    /* private mode / quota: the fallbacks still pick «Каркас» while unpaired */
  }
}

function safeLocalStorage(): KV | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

// Before any profile (pairing, profile picker) a TV wears, in order: the design it
// last showed (cached), else the server's default for new TVs (NEW_TV_DESIGN,
// docs/architecture.md «Device settings»; the pairing start reply carries it), else
// «Каркас» (that setting's own default) while unpaired / «Кинозал» once paired.
// The first frame (index.html) follows the same cache. A TV that has ever shown a
// profile keeps that profile's design.
import { DESIGNS, type DesignSetting } from "@martytv/ui";

export const NEW_TV_DESIGN: DesignSetting = "wireframe";
export const DESIGN_KEY = "martytv.design";
/** Set while DESIGN_KEY holds only the new-TV guess (no profile's design shown on this TV yet). */
export const SEEDED_KEY = "martytv.design_seeded";
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
    if (!kv.getItem(DESIGN_KEY) && !kv.getItem(CREDENTIAL_KEY)) {
      kv.setItem(DESIGN_KEY, NEW_TV_DESIGN);
      kv.setItem(SEEDED_KEY, "1");
    }
  } catch {
    /* private mode / quota: the fallbacks still pick «Каркас» while unpaired */
  }
}

/**
 * The pairing start reply names the server's design for new TVs (`""` = that default is off;
 * `undefined` = an older server). A TV still on the new-TV guess takes it (off → «Кинозал»);
 * a TV that has shown a profile keeps its own. True when the cached design changed.
 */
export function adoptServerNewTvDesign(server: string | undefined, kv: KV | null = safeLocalStorage()): boolean {
  if (!kv || server === undefined) return false;
  try {
    if (!kv.getItem(SEEDED_KEY) && kv.getItem(DESIGN_KEY)) return false;
    const next = (DESIGNS as string[]).includes(server) ? server : "kinozal";
    kv.setItem(SEEDED_KEY, "1");
    if (kv.getItem(DESIGN_KEY) === next) return false;
    kv.setItem(DESIGN_KEY, next);
    return true;
  } catch {
    return false;
  }
}

function safeLocalStorage(): KV | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

// «Сюрприз» and the per-title loading styles: which animation a load shows
// when the profile's loading_style is "surprise" (a different one each load,
// never the same twice in a row, remembered per device) — resolved once per
// load attempt, so the loader never changes mid-load. Shared by the TV and
// the web player; pure parts tested in loaderPick.test.ts.

/** Every concrete loading animation (what "surprise" picks from). */
export const LOADER_ANIMATIONS = [
  "popcorn",
  "fill_title",
  "poster_reveal",
  "film_reel",
  "minimal",
  "marty",
  "marty_popcorn",
  "matrix",
  "paws",
  "aquarium",
  "speed88",
  "odyssey",
  "balloons",
  "catch",
] as const;
export type LoaderAnimation = (typeof LOADER_ANIMATIONS)[number];

/** Settings values that pick an animation per load. */
export const LOADER_PICKERS = ["surprise"] as const;
export type LoaderPicker = (typeof LOADER_PICKERS)[number];

export function isLoaderPicker(s: string): s is LoaderPicker {
  return (LOADER_PICKERS as readonly string[]).includes(s);
}

/** A random animation other than `last` (`r` in [0, 1)). */
export function pickSurprise(last: string | null, r: number, pool: readonly LoaderAnimation[] = LOADER_ANIMATIONS): LoaderAnimation {
  const from = pool.filter((s) => s !== last);
  const list = from.length ? from : pool;
  return list[Math.min(list.length - 1, Math.floor(Math.max(0, r) * list.length))]!;
}

/** Where a device keeps its surprise: the last one shown and the next (picked ahead so its chunk can be fetched early). */
export interface SurpriseStore {
  get(): { last: LoaderAnimation | null; next: LoaderAnimation | null };
  set(v: { last: LoaderAnimation | null; next: LoaderAnimation | null }): void;
}

const KEY = "martytv.loaderSurprise";
const valid = (s: unknown): LoaderAnimation | null => ((LOADER_ANIMATIONS as readonly unknown[]).includes(s) ? (s as LoaderAnimation) : null);

export const localSurpriseStore: SurpriseStore = {
  get() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as { last?: unknown; next?: unknown } | null;
      return { last: valid(v?.last), next: valid(v?.next) };
    } catch {
      return { last: null, next: null };
    }
  },
  set(v) {
    try {
      localStorage.setItem(KEY, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
};

/** The surprise the next load will show (picked now if none is waiting; for preloading its chunk). */
export function upcomingSurprise(store: SurpriseStore = localSurpriseStore, rnd: () => number = Math.random): LoaderAnimation {
  const s = store.get();
  if (s.next && s.next !== s.last) return s.next;
  const next = pickSurprise(s.last, rnd());
  store.set({ last: s.last, next });
  return next;
}

/** Takes the waiting surprise for a load starting now and picks the one after it. */
export function takeSurprise(store: SurpriseStore = localSurpriseStore, rnd: () => number = Math.random): LoaderAnimation {
  const now = upcomingSurprise(store, rnd);
  store.set({ last: now, next: pickSurprise(now, rnd()) });
  return now;
}

/**
 * Resolves the setting to the animation for one load attempt (`attempt`
 * identifies it: the same attempt always gets the same answer). A concrete
 * style is returned as is.
 */
export class LoaderPick {
  private key: string | null = null;
  private style: LoaderAnimation = "popcorn";
  constructor(private store: SurpriseStore = localSurpriseStore, private rnd: () => number = Math.random) {}

  resolve(setting: string, attempt: string): LoaderAnimation {
    if (!isLoaderPicker(setting)) return valid(setting) ?? "popcorn";
    const key = `${setting}|${attempt}`;
    if (key !== this.key) {
      this.key = key;
      this.style = takeSurprise(this.store, this.rnd);
    }
    return this.style;
  }
}

/** The app's one picker (one load shows at a time). */
export const loaderPick = new LoaderPick();

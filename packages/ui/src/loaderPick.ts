// «Сюрприз» and the per-title loading styles: which animation a load shows
// when the profile's loading_style is "surprise" (a different one each load,
// never the same twice in a row, remembered per device) — resolved once per
// load attempt, so the loader never changes mid-load. Shared by the TV and
// the web player; pure parts tested in loaderPick.test.ts. «Под фильм»
// ("match") resolves the same way with loaderMatch.ts.
import { matchLoader, type MatchInfo } from "./loaderMatch";
import { isLoaderPicker, localSurpriseStore, takeSurprise, validLoader, type LoaderAnimation, type SurpriseStore } from "./loaderSurprise";

/**
 * Resolves the setting to the animation for one load attempt (`attempt`
 * identifies it: the same attempt always gets the same answer). A concrete
 * style is returned as is.
 */
export class LoaderPick {
  private key: string | null = null;
  private style: LoaderAnimation = "popcorn";
  constructor(private store: SurpriseStore = localSurpriseStore, private rnd: () => number = Math.random) {}

  /** `info`: what is loading, for «Под фильм» (read only when the attempt is new). */
  resolve(setting: string, attempt: string, info?: () => MatchInfo | null): LoaderAnimation {
    if (!isLoaderPicker(setting)) return validLoader(setting) ?? "popcorn";
    const key = `${setting}|${attempt}`;
    if (key !== this.key) {
      this.key = key;
      this.style = setting === "surprise" ? takeSurprise(this.store, this.rnd) : matchLoader(info?.() ?? null);
    }
    return this.style;
  }
}

/** The app's one picker (one load shows at a time). */
export const loaderPick = new LoaderPick();

// The arrows for an interactive loading style («Лови!»): while the loading
// screen is up, PlayerLayer's key handler hands ◀▶▲▼ here (after the slow-
// torrent hint, which keeps its ◀▶); Back, OK and the media keys stay the
// player's. One sink at a time; nothing is bound outside a load.
export type LoaderArrow = "left" | "right" | "up" | "down";

let sink: ((k: LoaderArrow) => void) | null = null;

/** The loader takes the arrows; returns the unbinding. */
export function bindLoaderKeys(move: (k: LoaderArrow) => void): () => void {
  sink = move;
  return () => {
    if (sink === move) sink = null;
  };
}

/** Gives an arrow to the bound loader; false when none takes it. */
export function loaderKey(k: string): boolean {
  if (!sink || (k !== "left" && k !== "right" && k !== "up" && k !== "down")) return false;
  sink(k);
  return true;
}

// «Видео» thumbnails ahead of focus: the next cards of the row and the rows
// around it go into the image cache before they scroll in (lazy images in
// a clipped row only start loading once visible). Two at a time, when the
// engine is idle, at low priority; nothing on screen waits for them.
import { gridThumbs, nearbyThumbs, ThumbPrefetcher } from "@martytv/media-types";
import type { VideoItem } from "./logic";

/** The thumbnail a card of width w shows (VideoThumb): 480×360 for the big cards, 320×180 below. */
export function cardThumb(v: Pick<VideoItem, "thumbnail" | "thumbnail_hd">, w: number): string {
  return w > 340 ? v.thumbnail_hd : v.thumbnail;
}

const LOAD_TIMEOUT = 15_000;

function loadImage(url: string, done: () => void) {
  const img = new Image();
  const timer = setTimeout(done, LOAD_TIMEOUT);
  img.onload = img.onerror = () => {
    clearTimeout(timer);
    done();
  };
  img.decoding = "async";
  (img as HTMLImageElement & { fetchPriority?: string }).fetchPriority = "low";
  img.src = url;
}

type IdleWindow = Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };

function idle(cb: () => void) {
  const w = window as IdleWindow;
  if (w.requestIdleCallback) w.requestIdleCallback(cb, { timeout: 400 });
  else setTimeout(cb, 60);
}

export const thumbPrefetch = new ThumbPrefetcher({ load: loadImage, idle, maxInFlight: 2 });

/** Focus on card `idx` of row `row` (rows: the focusable rows' items; starts: each row's focused index). */
export function prefetchAround(rows: readonly (readonly VideoItem[])[], row: number, idx: number, w: number, starts?: readonly number[]) {
  thumbPrefetch.want(nearbyThumbs(rows.map((r) => r.map((v) => cardThumb(v, w))), row, idx, { ahead: 10, next: 6, starts }));
}

/** Focus on card `idx` of a grid with `cols` columns. */
export function prefetchGrid(items: readonly VideoItem[], idx: number, cols: number, w: number) {
  thumbPrefetch.want(gridThumbs(items.map((v) => cardThumb(v, w)), idx, cols, 2));
}

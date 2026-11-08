// «Видео» thumbnails ahead of the viewer: cards of a horizontal row (lazy
// images off to the side wait for a scroll) once the row nears the screen,
// and the next cards of a grid as it scrolls. Two at a time, when idle, at
// low priority. A prefetch uses the card's own srcset/sizes, so the browser
// picks (and caches) the same file the card will show.
import { useEffect, useRef, type RefObject } from "react";
import { ThumbPrefetcher } from "@martytv/media-types";
import type { VideoItem } from "./logic";

/** Card thumbnails: 320×180 (mqdefault) or 480×360 (hqdefault, cropped to 16:9 by object-cover). */
export function thumbSrcSet(v: Pick<VideoItem, "thumbnail" | "thumbnail_hd">): string {
  return `${v.thumbnail} 320w, ${v.thumbnail_hd} 480w`;
}

/** `sizes` per card kind (CSS widths in ui.tsx). */
export const THUMB_SIZES = {
  grid: "(min-width: 1280px) 25vw, (min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw",
  row: "(min-width: 640px) 288px, 256px",
  compact: "(min-width: 640px) 176px, 160px",
  tiny: "112px",
} as const;

const SEP = "\n";

/** The prefetch key of a card's image: its srcset and sizes. */
export function thumbKey(v: Pick<VideoItem, "thumbnail" | "thumbnail_hd">, sizes: string): string {
  return thumbSrcSet(v) + SEP + sizes;
}

function load(key: string, done: () => void) {
  const [srcset, sizes] = key.split(SEP);
  const img = new Image();
  const timer = setTimeout(done, 15_000);
  img.onload = img.onerror = () => {
    clearTimeout(timer);
    done();
  };
  img.decoding = "async";
  img.fetchPriority = "low";
  img.sizes = sizes ?? "";
  img.srcset = srcset ?? "";
}

function idle(cb: () => void) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(cb, { timeout: 500 });
  else setTimeout(cb, 50);
}

export const thumbPrefetch = new ThumbPrefetcher({ load, idle, maxInFlight: 2 });

/** A horizontal row: every card's thumbnail once the row is within `margin` of the screen. */
export function useRowPrefetch(ref: RefObject<HTMLElement | null>, items: readonly VideoItem[], sizes: string, margin = "300px") {
  const keys = useRef<string[]>([]);
  useEffect(() => {
    keys.current = items.map((v) => thumbKey(v, sizes));
  });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) thumbPrefetch.want(keys.current);
    }, { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, margin, items.length]);
}

/** A grid: when card i nears the screen, the next `ahead` cards' thumbnails. Cards carry data-thumb-idx. */
export function useGridPrefetch(ref: RefObject<HTMLElement | null>, items: readonly VideoItem[], sizes: string, ahead = 6) {
  const keys = useRef<string[]>([]);
  useEffect(() => {
    keys.current = items.map((v) => thumbKey(v, sizes));
  });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          if (!e.isIntersecting) continue;
          const i = Number((e.target as HTMLElement).dataset.thumbIdx);
          if (Number.isFinite(i)) thumbPrefetch.want(keys.current.slice(i + 1, i + 1 + ahead));
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px 600px 0px" },
    );
    el.querySelectorAll("[data-thumb-idx]").forEach((c) => io.observe(c));
    return () => io.disconnect();
  }, [ref, ahead, items.length]);
}

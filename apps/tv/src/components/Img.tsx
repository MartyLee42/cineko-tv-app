import { useState } from "react";

/**
 * Image that fades in once loaded and disappears on error, so whatever is
 * behind it (a colored placeholder with the title) stays visible.
 */
export function Img({ src, className = "", alt = "" }: { src: string | null | undefined; className?: string; alt?: string }) {
  if (!src) return null;
  // Keyed by src: a new image starts hidden again.
  return <ImgInner key={src} src={src} className={className} alt={alt} />;
}

/**
 * Images that already loaded in this session (bounded). Rows and grids are
 * virtualized: a card that scrolls out of the render window unmounts, and
 * coming back it used to start hidden again — lazy, async-decoded, a 300 ms
 * fade from the placeholder — so scrolling a row made posters blink. A known
 * image now shows at once (eager, decoded with the frame, no fade).
 */
const shown = new Set<string>();
const SHOWN_MAX = 1500;

function remember(src: string) {
  if (shown.has(src)) return;
  shown.add(src);
  if (shown.size > SHOWN_MAX) shown.delete(shown.values().next().value as string);
}

/** Tests: whether `src` counts as already shown. */
export function wasShown(src: string): boolean {
  return shown.has(src);
}

function ImgInner({ src, className, alt }: { src: string; className: string; alt: string }) {
  const [known] = useState(() => shown.has(src));
  const [state, setState] = useState<"loading" | "ok" | "error">(known ? "ok" : "loading");
  if (state === "error") return null;
  return (
    <img
      src={src}
      alt={alt}
      decoding={known ? "sync" : "async"}
      // Always eager: rows and grids are virtualized already, and a lazy image
      // in a row's clipped track waits for the browser's own distance check —
      // the cards mounted ahead of the right edge (ROW_AHEAD) loaded late.
      loading="eager"
      draggable={false}
      onLoad={(e) => {
        remember(src);
        if (state === "ok") return;
        // Decoded before it shows: old TV engines (Tizen's Chrome 69) decode
        // an image only when it first paints, so the cards sliding in at a
        // row's edge showed their placeholder for a frame or two (a blink).
        const img = e.currentTarget;
        const show = () => setState("ok");
        if (typeof img.decode === "function") img.decode().then(show, show);
        else show();
      }}
      onError={() => setState("error")}
      className={`${known ? "" : "transition-opacity duration-300 "}${state === "ok" ? "opacity-100" : "opacity-0"} ${className}`}
    />
  );
}

/**
 * placeholderColor() returns space-separated hsl(), which Chrome < 65 can't
 * parse; rewrite it with commas for old TV engines.
 */
export function legacyColor(c: string): string {
  const m = /^hsl\(\s*([\d.]+)\s+([\d.]+%)\s+([\d.]+%)\s*\)$/.exec(c);
  return m ? `hsl(${m[1]}, ${m[2]}, ${m[3]})` : c;
}

/**
 * Full-bleed backdrop that cross-fades: the previous image stays underneath
 * while the next one fades in, so changing focus never flashes black.
 */
export function Backdrop({ src, className = "" }: { src: string | null | undefined; className?: string }) {
  const [layers, setLayers] = useState<string[]>(() => (src ? [src] : []));
  // Keep two earlier images: after quick changes the one on screen may be
  // two back while the newest is still loading (dropping it flashed black).
  if (src && layers[layers.length - 1] !== src) setLayers((l) => [...l.filter((x) => x !== src).slice(-2), src]);
  return (
    <div className={`relative h-full w-full overflow-hidden ${className}`}>
      {layers.map((s) => (
        <Img key={s} src={s} className="absolute left-0 top-0 h-full w-full object-cover" />
      ))}
    </div>
  );
}

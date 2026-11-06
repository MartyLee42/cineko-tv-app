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

function ImgInner({ src, className, alt }: { src: string; className: string; alt: string }) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  if (state === "error") return null;
  return (
    <img
      src={src}
      alt={alt}
      decoding="async"
      loading="lazy"
      draggable={false}
      onLoad={() => setState("ok")}
      onError={() => setState("error")}
      className={`transition-opacity duration-300 ${state === "ok" ? "opacity-100" : "opacity-0"} ${className}`}
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

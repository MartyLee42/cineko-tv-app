// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { Backdrop, pct, PosterCard, Status, type LoaderModel } from "../loaderParts";

/**
 * The title drawn as an outline, filled left→right with the accent colour.
 * The fill is a copy of the text inside a window that slides in from the
 * left while the copy slides the opposite way (two transforms = a moving
 * clip, no layout or repaint per frame).
 */
export default function FillTitle({ m }: { m: LoaderModel }) {
  const off = (1 - m.p) * 100;
  return (
    <>
      <Backdrop m={m} opacity={0.22} />
      <div className="tv-scrim-left absolute left-0 top-0 h-full w-full" />
      <div className="absolute left-[150px] top-1/2 -translate-y-1/2">
        <PosterCard m={m} w={400} h={600} className="tv-loader-float" />
      </div>
      <div className="absolute left-[650px] right-[120px] top-1/2 -translate-y-1/2">
        {m.episode && <p className="mb-6 truncate text-4xl text-muted">{m.episode}</p>}
        {/* Shrinks to the text, so the fill tracks the letters (not the column). */}
        <div className="relative inline-block max-w-full align-top">
          <h1 className="tv-loader-title tv-title-outline line-clamp-2">{m.title || "…"}</h1>
          <div className="tv-loader-ease absolute left-0 top-0 h-full w-full overflow-hidden" style={{ transform: `translate3d(${-off}%,0,0)` }}>
            <div className="tv-loader-ease h-full w-full" style={{ transform: `translate3d(${off}%,0,0)` }}>
              <h1 className="tv-loader-title line-clamp-2 text-accent">{m.title || "…"}</h1>
            </div>
            <span className="tv-fill-edge absolute right-0 top-0 h-full" />
          </div>
        </div>
        <div className="mt-14 flex items-end">
          <span className="w-[220px] shrink-0 text-7xl font-bold tabular-nums text-accent">{pct(m.p)}</span>
          <Status m={m} className="min-w-0" />
        </div>
      </div>
    </>
  );
}

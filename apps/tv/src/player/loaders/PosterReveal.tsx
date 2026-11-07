// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { Img } from "../../components/Img";
import { Backdrop, pct, PosterCard, Status, type LoaderModel } from "../loaderParts";

let filterOk: boolean | null = null;
function supportsFilter(): boolean {
  if (filterOk !== null) return filterOk;
  try {
    const c = (window as unknown as { CSS?: { supports?: (p: string, v: string) => boolean } }).CSS;
    filterOk = !!c?.supports && (c.supports("filter", "blur(2px)") || c.supports("-webkit-filter", "blur(2px)"));
  } catch {
    filterOk = false;
  }
  return filterOk;
}

/**
 * The poster starts blurred and grey and sharpens into colour: three static
 * layers (grey+heavy blur, light blur, sharp colour) cross-faded by
 * progress. Without CSS filters: a dim poster fading to full colour.
 */
export default function PosterReveal({ m }: { m: LoaderModel }) {
  const filters = supportsFilter();
  const mid = Math.min(1, m.p * 1.8);
  const sharp = Math.max(0, Math.min(1, (m.p - 0.45) / 0.55));
  const W = 440;
  const H = 660;
  return (
    <>
      <Backdrop m={m} opacity={0.1} />
      <div className="tv-scrim-bottom absolute left-0 top-0 h-full w-full" />
      <div className="absolute left-1/2 top-[70px] -translate-x-1/2">
        <PosterCard m={m} w={W} h={H}>
          {m.poster && (
            <>
              <Img src={m.poster} className={`absolute left-0 top-0 h-full w-full object-cover ${filters ? "tv-reveal-blur" : "tv-reveal-dim"}`} />
              {filters && (
                <div className="tv-loader-fade absolute left-0 top-0 h-full w-full" style={{ opacity: mid }}>
                  <Img src={m.poster} className="tv-reveal-soft absolute left-0 top-0 h-full w-full object-cover" />
                </div>
              )}
              <div className="tv-loader-fade absolute left-0 top-0 h-full w-full" style={{ opacity: sharp }}>
                <Img src={m.poster} className="absolute left-0 top-0 h-full w-full object-cover" />
              </div>
            </>
          )}
        </PosterCard>
      </div>
      <div className="absolute left-[200px] right-[200px] text-center" style={{ top: 70 + H + 44 }}>
        <h1 className="truncate text-6xl font-bold leading-tight">{m.title || "…"}</h1>
        {m.episode && <p className="mt-2 truncate text-3xl text-muted">{m.episode}</p>}
        <div className="mx-auto mt-8 flex w-[760px] items-center">
          <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-text/15">
            <div className="tv-loader-ease absolute left-0 top-0 h-full w-full origin-left rounded-full bg-accent" style={{ transform: `scaleX(${m.p})` }} />
          </div>
          <span className="ml-6 w-[110px] text-left text-4xl font-bold tabular-nums text-accent">{pct(m.p)}</span>
        </div>
        <Status m={m} className="mt-6 [&>p:first-child]:text-3xl" />
      </div>
    </>
  );
}

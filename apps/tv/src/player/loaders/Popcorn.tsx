// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { PopcornLoader } from "@martytv/ui/popcorn";
import { Backdrop, pct, Status, useStatus, type LoaderModel } from "../loaderParts";

/** The mascot's bucket fills with popcorn; title and status below. */
export default function Popcorn({ m }: { m: LoaderModel }) {
  const { status } = useStatus(m);
  return (
    <>
      <Backdrop m={m} opacity={0.18} />
      <div className="tv-scrim-bottom absolute left-0 top-0 h-full w-full" />
      <div className="absolute left-1/2 top-[110px] -translate-x-1/2">
        <PopcornLoader progress={m.p} size={440} label={`${status} ${pct(m.p)}`} />
      </div>
      <div className="absolute left-[160px] right-[160px] top-[640px] text-center">
        <h1 className="truncate text-6xl font-bold leading-tight">{m.title || "…"}</h1>
        {m.episode && <p className="mt-2 truncate text-3xl text-muted">{m.episode}</p>}
        <div className="mt-8 flex items-start justify-center">
          <span className="mr-8 text-6xl font-bold tabular-nums text-accent">{pct(m.p)}</span>
          <Status m={m} className="min-w-0 pt-1 text-left" />
        </div>
      </div>
    </>
  );
}

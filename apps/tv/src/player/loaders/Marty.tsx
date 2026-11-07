// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { Mascot } from "@martytv/ui";
import { Backdrop, Status, type LoaderModel } from "../loaderParts";

/** «Cineko»: the mascot's loading loop over the dimmed backdrop, a progress bar; he cheers at 100%. */
export default function MartyLoader({ m, mood }: { m: LoaderModel; mood: "loading" | "popcorn" }) {
  const done = m.p >= 0.999 || m.stage === "done";
  return (
    <>
      <Backdrop m={m} opacity={0.25} />
      <div className="absolute left-0 top-0 flex h-full w-full flex-col items-center justify-center px-[160px] text-center">
        <Mascot size={300} mood={done ? "happy" : mood} animated hat={null} />
        <h1 className="mt-6 max-w-[1500px] truncate text-6xl font-bold leading-tight">{m.title || "…"}</h1>
        {m.episode && <p className="mt-2 truncate text-3xl text-muted">{m.episode}</p>}
        <div className="relative mt-10 h-[8px] w-[900px] rounded-full bg-text/15">
          <div className="tv-loader-ease absolute left-0 top-0 h-full w-full origin-left rounded-full bg-accent" style={{ transform: `scaleX(${m.p})` }} />
        </div>
        <Status m={m} className="mt-8 [&>p:first-child]:text-3xl [&>p:first-child]:font-normal" />
      </div>
    </>
  );
}

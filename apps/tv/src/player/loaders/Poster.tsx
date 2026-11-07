// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { SloganTicker, SovietEmblem } from "@martytv/ui";
import { Backdrop, pct, Status, type LoaderModel } from "../loaderParts";

/**
 * A 1920s poster: the hammer and sickle in a big red disc (a dashed ring
 * turns around it), the title in heavy capitals, a slogan that changes every
 * ~3.5 s on a tilted red slab, the percentage on a black diagonal band and a
 * thick red bar. Transforms and opacity only.
 */
export default function PosterLoader({ m }: { m: LoaderModel }) {
  const grot = "var(--mt-font-display)";
  return (
    <div data-testid="cv-loader" className="absolute left-0 top-0 h-full w-full">
      <Backdrop m={m} opacity={0.1} />
      <svg className="absolute left-0 top-0" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden>
        <polygon points="0,1080 0,780 900,1080" fill="#d7261e" opacity=".85" />
        <line x1="980" y1="1080" x2="1920" y2="560" stroke="#efe4cc" strokeWidth="6" opacity=".18" />
      </svg>
      <div className="absolute" style={{ left: 1200, top: 120, width: 600, height: 600 }}>
        <div className="cvl-ring absolute left-0 top-0 h-full w-full rounded-full" />
        <div className="absolute rounded-full" style={{ left: 40, top: 40, width: 520, height: 520, background: "#d7261e" }} />
        <SovietEmblem size={380} bg={null} className="absolute" style={{ left: 110, top: 104 }} />
      </div>
      <div className="absolute left-[120px] top-[120px] w-[1020px]">
        <p className="text-[30px] font-bold uppercase tracking-[.3em] text-accent" style={{ fontFamily: grot }}>
          Киносеанс
        </p>
        <h1 className="mt-3 line-clamp-2 text-[96px] font-bold uppercase leading-[1.02] tracking-[.02em]" style={{ fontFamily: grot }}>
          {m.title || "…"}
        </h1>
        {m.episode && <p className="mt-3 truncate text-[36px] uppercase text-muted" style={{ fontFamily: grot }}>{m.episode}</p>}
        <div className="mt-10 origin-left" style={{ transform: "rotate(-3deg)" }}>
          <SloganTicker className="inline-block max-w-[1000px] bg-[#efe4cc] px-8 py-4 text-[48px] font-bold uppercase leading-[1.1] text-[#1a1512]" style={{ fontFamily: grot, height: 136 }} />
        </div>
      </div>
      <div className="absolute left-[-40px] top-[800px] flex h-[120px] w-[1100px] items-center bg-[#1a1512] pl-[160px]" style={{ transform: "rotate(-4deg)", transformOrigin: "0 50%" }}>
        <span className="text-[92px] font-bold tabular-nums leading-none text-[#efe4cc]" style={{ fontFamily: grot }}>
          {pct(m.p)}
        </span>
      </div>
      <div className="absolute bottom-[70px] left-[1160px] right-[120px]">
        <div className="relative h-[18px] bg-text/15">
          <div className="tv-loader-ease absolute left-0 top-0 h-full w-full origin-left bg-accent" style={{ transform: `scaleX(${m.p})` }} />
        </div>
        <Status m={m} className="mt-6 [&>p:first-child]:text-3xl [&>p:first-child]:uppercase" />
      </div>
    </div>
  );
}

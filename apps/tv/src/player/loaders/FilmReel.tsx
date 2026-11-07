// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import type { ReactNode } from "react";
import { placeholderColor } from "@martytv/media-types";
import { legacyColor } from "../../components/Img";
import { Backdrop, pct, Status, type LoaderModel } from "../loaderParts";

const FRAMES = 8;
const FRAME_W = 340;
const FRAME_GAP = 28;
const CELL = FRAME_W + FRAME_GAP;

/**
 * A film strip runs continuously across the screen; its frames light up one
 * by one with the artwork (panned frame to frame) as loading progresses (the frame being
 * "developed" pulses). The strip is two copies of the same frames so the
 * CSS animation loops seamlessly.
 */
export default function FilmReel({ m }: { m: LoaderModel }) {
  const lit = Math.floor(m.p * FRAMES + 0.0001);
  const img = m.backdrop ?? m.poster;
  const cells: ReactNode[] = [];
  for (let c = 0; c < FRAMES * 2; c++) {
    const i = c % FRAMES;
    const on = i < lit || m.p >= 1;
    const developing = i === lit && m.p < 1;
    cells.push(
      <div key={c} className="absolute top-0 h-full" style={{ left: c * CELL, width: CELL }}>
        <div className="tv-reel-holes absolute left-0 right-0 top-[10px] h-[20px]" />
        <div className="tv-reel-holes absolute bottom-[10px] left-0 right-0 h-[20px]" />
        <div
          className="absolute overflow-hidden rounded-lg"
          style={{ left: FRAME_GAP / 2, top: 44, width: FRAME_W, height: 212, background: legacyColor(placeholderColor(`${m.seed}${i}`)) }}
        >
          {img && (
            <div
              className={`tv-loader-fade absolute left-0 top-0 h-full w-full ${developing ? "tv-pulse" : ""}`}
              style={{
                opacity: on ? 1 : developing ? 0.55 : 0.1,
                // Each frame shows the artwork, panned a little further along the strip.
                backgroundImage: `url("${img}")`,
                backgroundSize: "cover",
                backgroundPosition: `${Math.round((i / (FRAMES - 1)) * 100)}% 50%`,
              }}
            />
          )}
          {!on && <div className="absolute left-0 top-0 h-full w-full bg-black/40" />}
        </div>
      </div>,
    );
  }
  return (
    <>
      <Backdrop m={m} opacity={0.12} />
      <div className="absolute left-[120px] right-[120px] top-[110px] text-center">
        <h1 className="truncate text-7xl font-bold leading-tight">{m.title || "…"}</h1>
        {m.episode && <p className="mt-3 truncate text-4xl text-muted">{m.episode}</p>}
      </div>
      <div className="tv-reel absolute left-0 right-0 top-[360px] h-[300px] overflow-hidden">
        <div className="tv-reel-track absolute left-0 top-0 h-full" style={{ width: CELL * FRAMES * 2 }}>
          {cells}
        </div>
        <div className="tv-reel-gate absolute left-1/2 top-0 h-full w-[520px] -translate-x-1/2" />
      </div>
      <div className="absolute left-[120px] right-[120px] top-[720px] flex items-start justify-center">
        <span className="mr-10 text-7xl font-bold tabular-nums text-accent">{pct(m.p)}</span>
        <Status m={m} className="min-w-0 pt-2" />
      </div>
    </>
  );
}

// «Поп-арт»: a comic page with Ben-Day dots and starbursts.
import "./popart.css";
import { useI18n } from "@martytv/ui";
import type { Look } from "./types";
import { burstPoints } from "@martytv/ui/decor";
import { layer } from "./common";

const BURST_PTS = burstPoints(150, 108, 66, 98, 13, 9);

/** «БАМ!»: a yellow starburst in black ink with a hard red shadow and comic lettering. */
function ComicBurst({ text, width, className = "", style }: { text: string; width: number; className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={`pointer-events-none ${className}`} style={style} width={width} height={Math.round(width * 0.72)} viewBox="0 0 300 216" aria-hidden>
      <polygon points={BURST_PTS} fill="#ff2d3c" stroke="#000" strokeWidth="5" strokeLinejoin="round" transform="translate(9 9)" />
      <polygon points={BURST_PTS} fill="#ffd600" stroke="#000" strokeWidth="5" strokeLinejoin="round" />
      <text x="150" y="124" textAnchor="middle" fontFamily="'Rubik Mono One', Unbounded, sans-serif" fontSize="40" fill="#ff2d3c" stroke="#000" strokeWidth="3" paintOrder="stroke">
        {text}
      </text>
    </svg>
  );
}

const COMIC_BURST = burstPoints(1760, 150, 230, 330, 15, 3);

/** Process blue with Ben-Day dots; a pale starburst behind the top-right corner and a red wedge (static). */
function ComicBackground() {
  return (
    <div data-skin-bg="comic" className={`pa-comic ${layer}`}>
      <svg className="absolute left-0 top-0" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden>
        <polygon points={COMIC_BURST} fill="#ffd600" opacity=".12" />
        <polygon points="0,1080 0,930 520,1080" fill="#ff2d3c" opacity=".2" />
      </svg>
    </div>
  );
}

/** Over Home's hero artwork: Ben-Day dots in two corners and one «БАМ!» burst. */
function PopHeroEdges({ height }: { height: number }) {
  const { t } = useI18n();
  return (
    <>
      <div className="pa-dots pointer-events-none absolute left-0 top-0 w-full" style={{ height }} />
      <div className="pa-dots-red pointer-events-none absolute left-0 top-0 w-full" style={{ height }} />
      <ComicBurst text={t("designs.popart.bam")} width={300} className="pa-burst absolute" style={{ right: 120, top: Math.round(height * 0.16) }} />
    </>
  );
}

export const look: Look = { Background: () => <ComicBackground />, HeroEdges: PopHeroEdges };

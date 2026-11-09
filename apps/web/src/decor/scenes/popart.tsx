// «Поп-арт»: a comic page — process blue with Ben-Day dots, a pale starburst behind the top
// corner and a red wedge; over Home's hero black and red dots and a «БАМ!» burst that pops in.
import { burstPoints } from "@martytv/ui/decor";
import { useI18n } from "@martytv/ui";
import type { WebLook } from "../look";
import "./popart.css";

const BG_BURST = burstPoints(300, 260, 190, 270, 15, 3);
const BURST = burstPoints(150, 108, 66, 98, 13, 9);

function Scene() {
  return (
    <div className="pa-scene wd-fill">
      <svg className="pa-bg-burst" viewBox="0 0 600 520">
        <polygon points={BG_BURST} fill="#ffd600" />
      </svg>
      <div className="pa-wedge" />
      <div className="pa-speed" />
    </div>
  );
}

/** «БАМ!»: a yellow starburst in black ink with a hard red shadow and comic lettering. */
function HeroEdges() {
  const { t } = useI18n();
  return (
    <>
      <div className="pa-dots" />
      <div className="pa-dots-red" />
      <svg className="pa-burst" viewBox="0 0 300 216">
        <polygon points={BURST} fill="#ff2d3c" stroke="#000" strokeWidth="5" strokeLinejoin="round" transform="translate(9 9)" />
        <polygon points={BURST} fill="#ffd600" stroke="#000" strokeWidth="5" strokeLinejoin="round" />
        <text x="150" y="124" textAnchor="middle" fontFamily="'Rubik Mono One', Unbounded, sans-serif" fontSize="40" fill="#ff2d3c" stroke="#000" strokeWidth="3" paintOrder="stroke">
          {t("designs.popart.bam")}
        </text>
      </svg>
    </>
  );
}

export const look: WebLook = { Scene, HeroEdges };

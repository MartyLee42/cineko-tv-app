// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { useMemo } from "react";
import { placeholderColor } from "@martytv/media-types";
import { useI18n } from "@martytv/ui";
import { Img, legacyColor } from "../../components/Img";
import { clawPose, hashSeed, seeded } from "../homage";
import type { LoaderModel } from "../loaderParts";
import { HomageLayout, isDone, useStalled } from "./homageParts";
import "./Claw.css";

/** The cabinet's glass (scene coordinates). */
const GL = 460;
const GW = 1000;
const RAIL = 70;
/** The claw's x over the chute (pose x 0) and over the poster (x 1). */
const X0 = 580;
const X1 = 1150;
const PW = 150;
const PH = 220;
const TOYS = ["#f87171", "#60a5fa", "#facc15", "#34d399", "#c084fc", "#fb923c", "#f472b6", "#22d3ee"];

/**
 * «Кран-машина»: a claw machine full of toys with the title's poster on
 * top of the pile. The claw travels over it, lowers, grips and lifts it,
 * carries it to the chute and lets go at 100 %. When loading stalls the
 * poster slips out of the claw back onto the pile — and it tries again.
 */
export default function Claw({ m }: { m: LoaderModel }) {
  const { t } = useI18n();
  const done = isDone(m);
  const stalled = useStalled(m.p);
  const pose = clawPose(done ? 1 : m.p);
  const slip = stalled && pose.holding;
  const holding = pose.holding && !slip;
  const x = X0 + (X1 - X0) * pose.x;
  const rope = 60 + 230 * pose.drop;
  const toys = useMemo(() => {
    const rnd = seeded(hashSeed(m.seed));
    return Array.from({ length: 22 }, (_, i) => ({
      x: 700 + rnd() * 720,
      y: 440 + rnd() * 110,
      s: 70 + rnd() * 50,
      c: TOYS[i % TOYS.length]!,
      k: i % 3,
    }));
  }, [m.seed]);
  const caption = slip ? t("loaders2.claw_machine.slip") : done ? t("loaders2.claw_machine.done") : t("loaders2.claw_machine.caption");
  const poster = (
    <div className="lm-poster absolute overflow-hidden rounded-lg" style={{ width: PW, height: PH, background: legacyColor(placeholderColor(m.seed)) }}>
      {m.poster && <Img src={m.poster} className="absolute left-0 top-0 h-full w-full object-cover" />}
    </div>
  );
  return (
    <HomageLayout m={m} name="claw_machine" caption={caption} backdrop={0.08}>
      <div className="lm-cabinet absolute rounded-[30px]" style={{ left: GL - 30, top: 20, width: GW + 60, height: 600 }} />
      <div className="lm-glass absolute overflow-hidden" style={{ left: GL, top: 40, width: GW, height: 560 }}>
        <div className="lm-chute absolute" style={{ left: 20, top: 380, width: 200, height: 180 }} />
        {toys.map((toy, i) => (
          <span
            key={i}
            className={`lm-toy lm-toy-${toy.k} absolute block`}
            style={{ left: toy.x - GL - toy.s / 2, top: toy.y - 40 - toy.s / 2, width: toy.s, height: toy.s, background: toy.c }}
          />
        ))}
        {/* the poster on the pile (until it's lifted), or falling into the chute at 100 % */}
        {!holding && !done && (
          <div className={`absolute ${slip ? "lm-slip" : ""}`} style={{ left: X1 - GL - PW / 2, top: 300, transform: "rotate(-8deg)" }}>
            {poster}
          </div>
        )}
        {done && (
          <div className="lm-drop absolute" style={{ left: X0 - GL - PW / 2, top: 160 }}>
            {poster}
          </div>
        )}
        <div className="lm-rail absolute left-0 w-full" style={{ top: RAIL - 40 - 10, height: 20 }} />
        {/* carriage + rope + claw, moved as one */}
        <div className="hg-ease absolute left-0 top-0" style={{ transform: `translate3d(${x - GL}px,0,0)` }}>
          <div className="lm-carriage absolute" style={{ left: -40, top: RAIL - 40 - 22, width: 80, height: 34 }} />
          <div className="lm-rope hg-ease absolute" style={{ left: -3, top: RAIL - 40, width: 6, height: 300, transform: `scaleY(${(rope / 300).toFixed(3)})` }} />
          <div className={`hg-ease absolute ${stalled ? "lm-wobble" : ""}`} style={{ left: 0, top: 0, transform: `translate3d(0,${RAIL - 40 + rope}px,0)` }}>
            {holding && <div className="absolute" style={{ left: -PW / 2, top: 54 }}>{poster}</div>}
            <svg className="absolute overflow-visible" style={{ left: -70, top: -10 }} width="140" height="110" viewBox="0 0 140 110" aria-hidden>
              <rect x="44" y="0" width="52" height="34" rx="8" fill="#b8c0c8" stroke="#4b545c" strokeWidth="4" />
              {[-1, 0, 1].map((side) => (
                <g key={side} className="lm-prong" style={{ transform: `rotate(${-side * (pose.closed && !slip ? -6 : 18)}deg)`, transformOrigin: "70px 30px" }}>
                  <path d={`M${70 + side * 14} 30 L${70 + side * 40} 82 L${70 + side * 22} 106`} fill="none" stroke="#9aa3ab" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
                </g>
              ))}
            </svg>
          </div>
        </div>
      </div>
    </HomageLayout>
  );
}

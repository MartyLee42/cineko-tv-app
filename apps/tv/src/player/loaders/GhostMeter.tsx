// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { useEffect, useRef } from "react";
import { useI18n } from "@martytv/ui";
import { meterLights, needleAngle } from "../homage";
import type { LoaderModel } from "../loaderParts";
import { beep, HomageLayout, isDone } from "./homageParts";
import "./GhostMeter.css";

const LIGHTS = 8;
const LIGHT_COLORS = ["#4ade80", "#4ade80", "#a3e635", "#facc15", "#facc15", "#fb923c", "#f87171", "#ef4444"];

/**
 * «Призракометр»: a hand-held detector. The needle climbs the dial, a row
 * of lamps lights up and the side arms rise with the buffer; at the top a
 * short beep (only with this device's interface sounds on).
 */
export default function GhostMeter({ m }: { m: LoaderModel }) {
  const { t } = useI18n();
  const done = isDone(m);
  const lit = meterLights(m.p, LIGHTS);
  // Hanging down at 0 %, raised a little above level at 100 %.
  const arm = 20 - 78 * (1 - m.p);
  const beeped = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!done || beeped.current) return;
    // Settings' looping thumbnail stays quiet.
    if (root.current?.closest('[data-testid="loader-preview"]')) return;
    beeped.current = true;
    beep(1480, 0.09);
    const id = setTimeout(() => beep(1760, 0.14), 150);
    return () => clearTimeout(id);
  }, [done]);
  return (
    <HomageLayout m={m} name="ghost_meter" caption={t(done ? "loaders2.ghost_meter.done" : "loaders2.ghost_meter.caption")} backdrop={0.1}>
      <div ref={root} className={`lg-device absolute left-1/2 top-[70px] -ml-[260px] ${done ? "is-top" : ""}`}>
        {/* the arms (behind the body), hinged at its top corners */}
        <div className="lg-arm lg-arm-l hg-ease absolute" style={{ transform: `rotate(${arm}deg)` }} />
        <div className="lg-arm lg-arm-r hg-ease absolute" style={{ transform: `rotate(${-arm}deg)` }} />
        <div className="lg-body absolute left-0 top-0 h-[460px] w-[520px] rounded-[34px]">
          <svg className="absolute left-[40px] top-[36px]" width="440" height="250" viewBox="0 0 440 250" aria-hidden>
            <path d="M20 230 A200 200 0 0 1 420 230 Z" fill="#efe6cf" stroke="#2b2a26" strokeWidth="6" />
            <path d="M318 62 A200 200 0 0 1 420 230 L380 230 A160 160 0 0 0 296 94 Z" fill="#e5484d" opacity=".85" />
            {Array.from({ length: 13 }, (_, i) => {
              const a = ((-66 + i * 11) * Math.PI) / 180;
              const r1 = i % 2 ? 176 : 164;
              return <line key={i} x1={220 + Math.sin(a) * r1} y1={230 - Math.cos(a) * r1} x2={220 + Math.sin(a) * 194} y2={230 - Math.cos(a) * 194} stroke="#2b2a26" strokeWidth={i % 2 ? 3 : 5} />;
            })}
            <g className="hg-ease" style={{ transform: `rotate(${needleAngle(m.p)}deg)`, transformOrigin: "220px 230px" }}>
              <g className="lg-jitter" style={{ transformOrigin: "220px 230px" }}>
                <path d="M216 230 L220 52 L224 230 Z" fill="#c1121f" />
              </g>
            </g>
            <circle cx="220" cy="230" r="18" fill="#2b2a26" />
          </svg>
          <div className="absolute left-[60px] top-[318px] flex">
            {LIGHT_COLORS.map((c, i) => (
              <span
                key={i}
                className={`lg-lamp mr-[16px] block h-[34px] w-[34px] rounded-full ${i < lit ? "is-on" : ""}`}
                style={{ background: i < lit ? c : "#3a3d3f", animationDelay: `${(i * 0.13).toFixed(2)}s` }}
              />
            ))}
          </div>
          <div className="lg-grille absolute bottom-[26px] left-[60px] h-[40px] w-[400px] rounded-lg" />
        </div>
      </div>
    </HomageLayout>
  );
}

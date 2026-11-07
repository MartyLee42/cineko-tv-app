// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { useI18n } from "@martytv/ui";
import { rippleRings, rippleStrength } from "../homage";
import type { LoaderModel } from "../loaderParts";
import { HomageLayout, isDone } from "./homageParts";
import "./Glass.css";

const CX = 380;
const CY = 214;

/**
 * «Стакан воды»: a glass on a table; rings run across the water, fainter
 * at first and stronger as the buffer fills; at 100 % one big ring and the
 * glass gives a jolt.
 */
export default function Glass({ m }: { m: LoaderModel }) {
  const { t } = useI18n();
  const done = isDone(m);
  const k = rippleStrength(m.p);
  const rings = rippleRings(m.p);
  return (
    <HomageLayout
      m={m}
      name="water_glass"
      caption={t(done ? "loaders2.water_glass.done" : "loaders2.water_glass.caption")}
      backdrop={0.1}
      full={<div className="lw-table absolute bottom-0 left-0 w-full" style={{ top: 532 }} />}
    >
      <div className={`absolute left-1/2 top-[40px] -ml-[380px] ${done ? "lw-jolt" : ""}`}>
        <svg width="760" height="540" viewBox="0 0 760 540" aria-hidden>
          <defs>
            <clipPath id="lw-surface">
              <ellipse cx={CX} cy={CY} rx="128" ry="30" />
            </clipPath>
            <linearGradient id="lw-water" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#9fd0f2" stopOpacity=".55" />
              <stop offset="1" stopColor="#4d8fc2" stopOpacity=".55" />
            </linearGradient>
          </defs>
          {/* shadow on the table */}
          <ellipse cx={CX} cy="512" rx="150" ry="18" fill="rgba(0,0,0,.35)" />
          {/* water below the surface */}
          <path d={`M252 ${CY} L272 492 Q${CX} 516 488 492 L508 ${CY} Z`} fill="url(#lw-water)" />
          <ellipse cx={CX} cy={CY} rx="128" ry="30" fill="#bfe3fb" fillOpacity=".5" />
          {/* the rings, clipped to the surface */}
          <g clipPath="url(#lw-surface)" style={{ opacity: 0.5 + 0.5 * k }}>
            {[0, 1, 2].slice(0, rings).map((i) => (
              // A crest (light) with its trough (dark) just inside: reads as a wave.
              <g
                key={i}
                className="lw-ring"
                style={{ transformOrigin: `${CX}px ${CY}px`, animationDelay: `${i * 0.6}s`, animationDuration: `${2.2 - k}s`, transform: `scale(${0.35 + i * 0.3})` }}
              >
                <ellipse cx={CX} cy={CY} rx="124" ry="29" fill="none" stroke="#fff" strokeWidth={3 + 5 * k} />
                <ellipse cx={CX} cy={CY} rx="108" ry="24" fill="none" stroke="#1f4f78" strokeOpacity=".55" strokeWidth={2 + 4 * k} />
              </g>
            ))}
            {done && <ellipse className="lw-big" cx={CX} cy={CY} rx="126" ry="29" fill="none" stroke="#fff" strokeWidth="9" style={{ transformOrigin: `${CX}px ${CY}px` }} />}
          </g>
          {/* the glass */}
          <path d={`M232 40 L270 496 Q${CX} 522 490 496 L528 40`} fill="rgba(220,240,255,.07)" stroke="rgba(235,245,255,.7)" strokeWidth="4" strokeLinejoin="round" />
          <ellipse cx={CX} cy="40" rx="148" ry="22" fill="none" stroke="rgba(235,245,255,.75)" strokeWidth="4" />
          <path d="M262 80 L290 470" stroke="rgba(255,255,255,.35)" strokeWidth="10" strokeLinecap="round" />
          <path d="M498 90 L482 300" stroke="rgba(255,255,255,.18)" strokeWidth="6" strokeLinecap="round" />
        </svg>
      </div>
    </HomageLayout>
  );
}

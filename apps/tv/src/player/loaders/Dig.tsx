// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { placeholderColor } from "@martytv/media-types";
import { useI18n } from "@martytv/ui";
import { Img, legacyColor } from "../../components/Img";
import type { LoaderModel } from "../loaderParts";
import { HomageLayout, isDone } from "./homageParts";
import "./Dig.css";

const W = 360;
const H = 540;
/** The cracks that spread from behind the poster, in the order they appear. */
const CRACKS = [
  "M182 0 L170 -40 L184 -70 L176 -104",
  "M360 120 L398 112 L420 130 L456 122",
  "M0 300 L-34 292 L-52 312 L-90 306",
  "M360 420 L392 440 L404 470 L436 478",
  "M60 540 L52 572 L70 596",
  "M0 80 L-30 64 L-40 40",
  "M300 540 L316 570 L306 598",
  "M360 260 L396 268 L412 250",
];

/**
 * «Подкоп»: the title's poster hangs on a concrete wall; behind it a little
 * hammer chips away — chips fall, cracks spread and the dark hole grows
 * until it peeks out around the edges; at 100 % the poster tears in two and
 * the halves swing away.
 */
export default function Dig({ m }: { m: LoaderModel }) {
  const { t } = useI18n();
  const done = isDone(m);
  const hole = 0.3 + 0.72 * m.p;
  const cracks = Math.floor(m.p * CRACKS.length + 0.0001);
  const half = (side: "l" | "r") => (
    <div
      className={`ld-half ld-half-${side} absolute top-0 h-full overflow-hidden`}
      style={{ left: side === "l" ? 0 : W / 2, width: W / 2, background: legacyColor(placeholderColor(m.seed)) }}
    >
      <div className="absolute top-0 h-full" style={{ left: side === "l" ? 0 : -W / 2, width: W }}>
        {m.poster ? (
          <Img src={m.poster} className="absolute left-0 top-0 h-full w-full object-cover" />
        ) : (
          <p className="absolute bottom-0 left-0 w-full p-6 text-3xl font-semibold text-white">{m.title}</p>
        )}
      </div>
    </div>
  );
  return (
    <HomageLayout m={m} name="poster_dig" caption={t(done ? "loaders2.poster_dig.done" : "loaders2.poster_dig.caption")} backdrop={0.06} tone="ld-wall">
      <div className="absolute left-1/2 top-[44px]" style={{ marginLeft: -W / 2, width: W, height: H }}>
        {/* the tunnel: a dark rough hole, with a little light far away */}
        <svg className="ld-hole hg-ease absolute" width="520" height="700" viewBox="0 0 520 700" style={{ left: -80, top: -80, transform: `scale(${hole})` }} aria-hidden>
          <defs>
            <radialGradient id="ld-depth" cx="50%" cy="56%" r="50%">
              <stop offset="0" stopColor="#3d3a33" />
              <stop offset=".18" stopColor="#14120f" />
              <stop offset="1" stopColor="#050504" />
            </radialGradient>
          </defs>
          <path d="M120 40 L210 14 L300 30 L400 22 L470 90 L500 210 L488 330 L506 450 L470 580 L380 660 L260 684 L150 662 L60 590 L22 460 L36 320 L14 200 L50 96 Z" fill="url(#ld-depth)" stroke="#2a2722" strokeWidth="10" strokeLinejoin="round" />
        </svg>
        <svg className="absolute left-0 top-0 overflow-visible" width={W} height={H} aria-hidden>
          {CRACKS.slice(0, cracks).map((d, i) => (
            <path key={i} d={d} fill="none" stroke="rgba(30,28,24,.75)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </svg>
        {/* the hammer at work behind the bottom-right corner, chips falling */}
        {!done && (
          <>
            <div className="ld-hammer absolute" style={{ left: W - 30, top: H - 120 }}>
              <svg width="120" height="120" viewBox="0 0 120 120" aria-hidden>
                <rect x="52" y="30" width="12" height="80" rx="5" fill="#8a5a33" />
                <path d="M24 18 L96 18 L104 30 L92 40 L28 40 Z" fill="#9aa1a6" stroke="#5d6368" strokeWidth="3" />
              </svg>
            </div>
            {[0, 1, 2].map((i) => (
              <span key={i} className="ld-chip absolute block" style={{ left: W - 10 + i * 18, top: H - 30, animationDelay: `${i * 0.35}s` }} />
            ))}
          </>
        )}
        <div className="ld-rubble hg-ease absolute" style={{ left: W - 70, top: H + 6, transform: `scaleY(${0.2 + m.p})` }} />
        {/* the poster: two halves that part at 100 % */}
        <div className={`ld-poster absolute left-0 top-0 ${done ? "is-torn" : ""}`} style={{ width: W, height: H }}>
          {half("l")}
          {half("r")}
          <span className="ld-pin absolute left-[14px] top-[14px]" />
          <span className="ld-pin absolute right-[14px] top-[14px]" />
        </div>
      </div>
    </HomageLayout>
  );
}

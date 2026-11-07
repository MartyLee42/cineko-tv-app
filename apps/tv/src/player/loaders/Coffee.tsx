// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { useI18n } from "@martytv/ui";
import type { LoaderModel } from "../loaderParts";
import { HomageLayout } from "./homageParts";
import "./Coffee.css";

/** The cup's inside, as drawn (the coffee is clipped to it). */
const INSIDE = "M120 96 L132 330 Q140 392 210 392 L290 392 Q360 392 368 330 L380 96 Z";

/**
 * «Чашка кофе»: heavy curtains, a zig-zag floor and a cup on its saucer
 * that fills with coffee as the film loads; steam once it's warm.
 */
export default function Coffee({ m }: { m: LoaderModel }) {
  const { t } = useI18n();
  // The coffee's surface: 0 % at the bottom (y 392), 100 % just under the rim (y 112).
  const level = 280 * (1 - m.p);
  return (
    <HomageLayout m={m} name="coffee_cup" caption={t("loaders2.coffee_cup.caption")} backdrop={0} tone="lk-room">
      <div className="lk-floor absolute bottom-0 left-0 h-[170px] w-full" />
      <div className="absolute left-1/2 top-[60px] -ml-[260px]">
        <svg width="520" height="520" viewBox="0 0 520 520" aria-hidden>
          <defs>
            <clipPath id="lk-inside">
              <path d={INSIDE} />
            </clipPath>
          </defs>
          {/* steam */}
          <g className="hg-fade" style={{ opacity: m.p > 0.15 ? 0.8 : 0 }}>
            {[0, 1, 2].map((i) => (
              <path
                key={i}
                className="lk-steam"
                d={`M${190 + i * 60} 80 C${170 + i * 60} 50 ${215 + i * 60} 30 ${192 + i * 60} 0`}
                fill="none"
                stroke="rgba(255,255,255,.55)"
                strokeWidth="9"
                strokeLinecap="round"
                style={{ animationDelay: `${i * 0.7}s` }}
              />
            ))}
          </g>
          {/* saucer */}
          <ellipse cx="250" cy="430" rx="230" ry="44" fill="#d9d4cc" />
          <ellipse cx="250" cy="420" rx="170" ry="26" fill="#c3bdb3" />
          {/* handle */}
          <path d="M372 150 C470 140 476 290 360 300" fill="none" stroke="#f1ede6" strokeWidth="30" strokeLinecap="round" />
          {/* cup */}
          <path d="M104 84 L118 334 Q128 412 210 412 L290 412 Q372 412 382 334 L396 84 Z" fill="#f4f0ea" />
          <path d={INSIDE} fill="#e2dbd0" />
          <path d="M120 96 L380 96 L378 130 Q250 112 122 130 Z" fill="#cfc6b8" />
          <g clipPath="url(#lk-inside)">
            <g className="hg-ease" style={{ transform: `translate3d(0,${level}px,0)` }}>
              <rect x="100" y="112" width="300" height="300" fill="#5b3418" />
              <ellipse cx="250" cy="112" rx="140" ry="14" fill="#8a5630" />
            </g>
          </g>
          <ellipse cx="250" cy="90" rx="146" ry="16" fill="none" stroke="#fff" strokeWidth="10" />
          <path d="M138 120 L150 320" stroke="rgba(255,255,255,.6)" strokeWidth="10" strokeLinecap="round" />
        </svg>
      </div>
    </HomageLayout>
  );
}

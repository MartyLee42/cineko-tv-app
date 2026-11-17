// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { useI18n } from "@martytv/ui";
import type { LoaderModel } from "../loaderParts";
import { foldOf } from "../loaderSteps";
import { HomageLayout, isDone } from "./homageParts";
import "./PaperCrane.css";

const PAPER = "#e8503a";
const LIGHT = "#f47a63";
const DARK = "#b8341f";
const CREASE = "rgba(255,255,255,.55)";

/** The shapes, drawn in a 600 × 460 box: each fold one group, cross-faded. */
function Fold({ n }: { n: number }) {
  switch (n) {
    case 0:
      return (
        <g>
          <rect x="140" y="70" width="320" height="320" fill={PAPER} />
          <path d="M140 70 L460 390" stroke={CREASE} strokeWidth="3" strokeDasharray="10 8" />
        </g>
      );
    case 1:
      return (
        <g>
          <path d="M140 70 L460 390 L140 390 Z" fill={PAPER} />
          <path d="M140 70 L460 390" stroke={DARK} strokeWidth="4" />
          <path d="M140 390 L300 230" stroke={CREASE} strokeWidth="3" strokeDasharray="10 8" />
        </g>
      );
    case 2:
      return (
        <g>
          <path d="M300 60 L450 225 L300 420 L150 225 Z" fill={PAPER} />
          <path d="M300 60 L300 420" stroke={DARK} strokeWidth="4" />
          <path d="M300 60 L150 225 L300 420 Z" fill={LIGHT} opacity=".6" />
          <path d="M210 160 L390 160" stroke={CREASE} strokeWidth="3" strokeDasharray="10 8" />
        </g>
      );
    case 3:
      return (
        <g>
          <path d="M300 40 L372 262 L300 430 L228 262 Z" fill={PAPER} />
          <path d="M300 40 L300 430" stroke={DARK} strokeWidth="4" />
          <path d="M300 40 L228 262 L300 300 Z" fill={LIGHT} />
          <path d="M300 40 L372 262 L300 300 Z" fill={DARK} opacity=".55" />
          <path d="M228 262 L300 300 L372 262" fill="none" stroke={CREASE} strokeWidth="3" strokeDasharray="10 8" />
        </g>
      );
    default:
      // A classic crane in profile: the far wing, the body, the near wing, the neck with the bent head, the tail.
      return (
        <g>
          <g className="pc-wings">
            <path d="M262 292 L360 58 L338 292 Z" fill={DARK} />
          </g>
          <path d="M196 300 L300 254 L404 300 L300 346 Z" fill={PAPER} />
          <path d="M300 254 L404 300 L300 346 Z" fill={DARK} opacity=".35" />
          <g className="pc-wings">
            <path d="M292 290 L424 72 L372 302 Z" fill={LIGHT} />
          </g>
          <path d="M226 304 L138 120 L156 116 L252 294 Z" fill={PAPER} />
          <path d="M138 120 L104 160 L150 130 Z" fill={DARK} />
          <path d="M368 302 L482 126 L494 134 L386 308 Z" fill={PAPER} />
        </g>
      );
  }
}

/**
 * «Журавлик»: a square of red paper folds into a crane, one fold per step of
 * the progress (cross-fading with a little «press» on each new fold); at
 * 100 % the crane flaps its wings and flies off to the upper right.
 */
export default function PaperCrane({ m }: { m: LoaderModel }) {
  const { t } = useI18n();
  const done = isDone(m);
  const fold = foldOf(m.p, done);
  return (
    <HomageLayout m={m} name="paper_crane" caption={t(done ? "loaders2.paper_crane.done" : "loaders2.paper_crane.caption")} backdrop={0.08} full={<div className="pc-desk absolute left-0 top-0 h-full w-full" />}>
      <div className={`absolute ${done ? "pc-fly" : ""}`} style={{ left: 660, top: 90, width: 600, height: 460 }}>
        <svg width="600" height="460" viewBox="0 0 600 460" aria-hidden className="overflow-visible">
          <ellipse cx="300" cy="446" rx={fold === 4 ? 150 : 170} ry="12" fill="rgba(0,0,0,.28)" />
          {[0, 1, 2, 3, 4].map((n) => (
            <g key={n} className={`hg-fade ${n === fold ? "pc-press" : ""}`} style={{ opacity: n === fold ? 1 : 0 }}>
              <Fold n={n} />
            </g>
          ))}
        </svg>
        {/* the folds so far, as dots under the paper */}
        <div className="absolute left-0 flex w-full justify-center" style={{ top: 470 }}>
          {[1, 2, 3, 4].map((n) => (
            <span key={n} className={`mx-[9px] block h-[14px] w-[14px] rotate-45 ${n <= fold ? "bg-accent" : "bg-text/25"}`} />
          ))}
        </div>
      </div>
    </HomageLayout>
  );
}

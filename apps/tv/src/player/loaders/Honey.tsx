// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { useI18n } from "@martytv/ui";
import { beeCount } from "../homage";
import type { LoaderModel } from "../loaderParts";
import { HomageLayout, useStalled } from "./homageParts";
import "./Honey.css";

const BODY = "M110 120 Q60 150 56 250 Q52 380 150 420 L290 420 Q388 380 384 250 Q380 150 330 120 Z";

/**
 * «Горшочек мёда»: bees — one per few of the torrent's peers — fly to a
 * clay pot and the honey rises with the buffer. When nothing has moved for
 * ~6 s: «Это неправильные пчёлы!».
 */
export default function Honey({ m }: { m: LoaderModel }) {
  const { t } = useI18n();
  const stalled = useStalled(m.p);
  const peers = m.torrent?.peers ?? 0;
  const bees = m.online ? 3 : beeCount(peers);
  const caption = stalled ? t("loaders2.honey_pot.wrong") : m.online ? t("loaders2.honey_pot.online") : t("loaders2.honey_pot.bees", { n: peers });
  const level = 300 * (1 - m.p);
  return (
    <HomageLayout m={m} name="honey_pot" caption={caption} backdrop={0.08} tone="lh-meadow">
      <div className="absolute left-1/2 top-[90px] -ml-[220px]">
        <svg width="440" height="470" viewBox="0 0 440 470" aria-hidden>
          <defs>
            <clipPath id="lh-body">
              <path d={BODY} />
            </clipPath>
          </defs>
          <ellipse cx="220" cy="440" rx="190" ry="22" fill="rgba(0,0,0,.25)" />
          <path d={BODY} fill="#b4673a" />
          {/* the honey shows through the pot (a cut-away), rising */}
          <g clipPath="url(#lh-body)">
            <g className="hg-ease" style={{ transform: `translate3d(0,${level}px,0)` }}>
              <rect x="40" y="120" width="360" height="320" fill="#f2a20c" />
              <path d="M40 120 Q100 106 160 120 T280 120 T400 120 L400 136 L40 136 Z" fill="#ffc94a" />
            </g>
          </g>
          <path d={BODY} fill="none" stroke="#7a3f1e" strokeWidth="8" />
          <path d="M96 92 L344 92 Q364 92 360 112 L354 128 L86 128 L80 112 Q76 92 96 92 Z" fill="#c97947" stroke="#7a3f1e" strokeWidth="8" strokeLinejoin="round" />
          <path d="M120 170 Q110 260 140 340" fill="none" stroke="rgba(255,255,255,.28)" strokeWidth="14" strokeLinecap="round" />
          {/* a drip over the rim once it's nearly full */}
          <path className="hg-fade" style={{ opacity: m.p > 0.85 ? 1 : 0 }} d="M300 128 Q304 170 296 186 Q290 196 296 204 Q306 196 304 180 Q312 160 310 128 Z" fill="#f2a20c" />
        </svg>
      </div>
      {Array.from({ length: bees }, (_, i) => (
        <div key={i} className={`lh-flight lh-path-${i % 4} absolute left-1/2 top-[160px] ${stalled ? "is-wrong" : ""}`} style={{ animationDelay: `${-i * 1.3}s`, animationDuration: `${6 + (i % 3)}s` }}>
          <div className="lh-bee">
            <span className="lh-wing lh-wing-a" />
            <span className="lh-wing lh-wing-b" />
          </div>
        </div>
      ))}
    </HomageLayout>
  );
}

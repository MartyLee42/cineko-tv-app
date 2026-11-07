// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { useI18n } from "@martytv/ui";
import type { LoaderModel } from "../loaderParts";
import { HomageLayout, isDone } from "./homageParts";
import "./Docking.css";

const CX = 960;
const CY = 300;
const MODULES = 12;

/**
 * «Стыковка»: a station ring spins in space; a small craft closes in from
 * the lower right as the buffer fills, starts spinning with the ring once
 * near, and locks onto the hub at 100 % (a glow on the ring).
 */
export default function Docking({ m }: { m: LoaderModel }) {
  const { t } = useI18n();
  const done = isDone(m);
  const far = 1 - m.p;
  const near = m.p > 0.7;
  const space = <div className="lx-space absolute left-0 top-0 h-full w-full" />;
  return (
    <HomageLayout m={m} name="docking" caption={t(done ? "loaders2.docking.done" : "loaders2.docking.caption")} backdrop={0} full={space} className="lx-root">
      <div className="lx-ring absolute" style={{ left: CX - 260, top: CY - 260 }}>
        <svg width="520" height="520" viewBox="0 0 520 520" aria-hidden>
          <circle cx="260" cy="260" r="214" fill="none" stroke="#9aa3ad" strokeWidth="14" />
          {Array.from({ length: MODULES }, (_, i) => (
            <rect key={i} x="236" y="22" width="48" height="64" rx="6" fill={i % 3 ? "#d7dce1" : "#b9c1c9"} stroke="#5f6870" strokeWidth="4" transform={`rotate(${(360 / MODULES) * i} 260 260)`} />
          ))}
          {[0, 90, 180, 270].map((a) => (
            <rect key={a} x="254" y="84" width="12" height="130" fill="#7b848d" transform={`rotate(${a + 15} 260 260)`} />
          ))}
          <circle cx="260" cy="260" r="46" fill="#cfd5db" stroke="#5f6870" strokeWidth="5" />
          <circle cx="260" cy="260" r="20" fill="#20262c" />
        </svg>
      </div>
      {done && <div className="lx-glow absolute" style={{ left: CX - 280, top: CY - 280 }} />}
      <div className="hg-ease absolute" style={{ left: CX - 90, top: CY - 90, transform: `translate3d(${Math.round(520 * far)}px,${Math.round(240 * far)}px,0) scale(${(0.6 + 0.4 * m.p).toFixed(3)})` }}>
        <div className={near ? "lx-spin" : ""}>
          <svg width="180" height="180" viewBox="0 0 120 120" aria-hidden>
            <path d="M60 8 L84 44 L84 84 L60 112 L36 84 L36 44 Z" fill="#eef1f4" stroke="#56606a" strokeWidth="5" strokeLinejoin="round" />
            <path d="M36 54 L8 70 L36 78 Z M84 54 L112 70 L84 78 Z" fill="#a9b2bb" stroke="#56606a" strokeWidth="4" strokeLinejoin="round" />
            <circle cx="60" cy="58" r="11" fill="#20262c" />
          </svg>
        </div>
      </div>
    </HomageLayout>
  );
}

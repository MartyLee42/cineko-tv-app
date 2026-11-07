// A loading style (its own chunk: fetched for the profile's style only, see loaderChunks.ts).
import { useMemo } from "react";
import { useI18n } from "@martytv/ui";
import { hashSeed, seeded } from "../homage";
import type { LoaderModel } from "../loaderParts";
import { HomageLayout, isDone } from "./homageParts";
import "./Hyperjump.css";

const STARS = 150;

/**
 * «Гиперпрыжок»: a star field drifts slowly toward the viewer while the
 * film loads; from 90 % the stars start to stretch and at 100 % they shoot
 * out into long lines with a flash. Each star is one element rotated to its
 * angle and moved out along it — only transforms change.
 */
export default function Hyperjump({ m }: { m: LoaderModel }) {
  const { t } = useI18n();
  const done = isDone(m);
  const stars = useMemo(() => {
    const rnd = seeded(hashSeed(m.seed));
    return Array.from({ length: STARS }, () => ({ a: rnd() * 360, r: 40 + Math.pow(rnd(), 0.7) * 1060, s: 2 + Math.round(rnd() * 4), o: 0.45 + rnd() * 0.55 }));
  }, [m.seed]);
  const pre = m.p >= 0.9 && !done ? 1 + (m.p - 0.9) * 40 : 1;
  const field = (
    <div className="lj-space absolute left-0 top-0 h-full w-full overflow-hidden">
      <div className="lj-drift absolute left-0 top-0 h-full w-full">
        {stars.map((s, i) => (
          <span
            key={i}
            className={`lj-star absolute block ${done ? "is-gone" : ""}`}
            style={{
              width: s.s * 2,
              height: s.s,
              marginTop: -s.s / 2,
              opacity: s.o,
              transform: done ? `rotate(${s.a}deg) translate3d(${s.r * 1.25}px,0,0) scaleX(90)` : `rotate(${s.a}deg) translate3d(${s.r}px,0,0) scaleX(${pre})`,
            }}
          />
        ))}
      </div>
      {done && <div className="lj-flash absolute left-0 top-0 h-full w-full" />}
    </div>
  );
  return (
    <HomageLayout m={m} name="hyperjump" caption={t(done ? "loaders2.hyperjump.done" : "loaders2.hyperjump.caption")} backdrop={0} full={field} className="lj-root">
      {null}
    </HomageLayout>
  );
}

// «Салют»: rockets rise over a dark skyline and burst into rings of sparks;
// now and then the sparks spell «CINEKO». Three slots, each one looping its
// own CSS cycle (rise, then burst); every new cycle takes a new spot and
// colour (onAnimationIteration). Transform / opacity only.
import { useMemo, useState } from "react";
import { burstOf, type Burst } from "../logic";

const SLOTS = 3;
const SPARKS = 24;
/** The inner ring: fewer sparks, about half the reach. */
const INNER = 12;
/** One rise + burst (s); the slots start a third apart. */
const CYCLE_S = 3.6;

/** A city along the bottom: blocks of different heights with a few lit windows (static). */
function Skyline() {
  const blocks = useMemo(() => {
    const out: { x: number; w: number; h: number }[] = [];
    let x = 0;
    let k = 7;
    const r = () => ((k = (k * 9301 + 49297) % 233280) / 233280);
    while (x < 1920) {
      const w = 60 + Math.round(r() * 110);
      out.push({ x, w, h: 70 + Math.round(r() * 170) });
      x += w + 4;
    }
    return out;
  }, []);
  return (
    <svg className="absolute bottom-0 left-0" width="1920" height="260" viewBox="0 0 1920 260" aria-hidden>
      {blocks.map((b) => (
        <g key={b.x}>
          <rect x={b.x} y={260 - b.h} width={b.w} height={b.h} fill="#0b0e17" />
          {Array.from({ length: Math.floor(b.h / 46) }, (_, i) => (
            <rect key={i} x={b.x + 14 + ((i * 23) % Math.max(1, b.w - 34))} y={260 - b.h + 18 + i * 40} width="10" height="14" fill="#f5c76a" opacity={(b.x + i) % 3 ? 0.18 : 0.55} />
          ))}
        </g>
      ))}
    </svg>
  );
}

/** «CINEKO» in dots (5 × 7 per letter). */
const GLYPHS: Record<string, string[]> = {
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
};
const WORD_DOTS = (() => {
  const dots: [number, number][] = [];
  "CINEKO".split("").forEach((ch, li) =>
    GLYPHS[ch]!.forEach((row, y) => row.split("").forEach((c, x) => c === "1" && dots.push([(li * 6 + x - 17.5) * 15, (y - 3) * 15]))),
  );
  return dots;
})();

function Slot({ slot }: { slot: number }) {
  const [n, setN] = useState(0);
  const b: Burst = useMemo(() => burstOf(slot, n, Math.random), [slot, n]);
  const anim = { animationDuration: `${CYCLE_S}s`, animationDelay: `${(slot * CYCLE_S) / SLOTS}s` };
  return (
    <div className="absolute left-0 top-0" style={{ transform: `translate3d(${b.x}px,${b.y}px,0)` }}>
      {/* The rocket: rises from below the skyline to the burst point (first 30 % of the cycle). */}
      <span className="fw-rocket" style={{ ...anim, background: b.color, ["--fw-rise" as string]: `${1080 - b.y}px` }} onAnimationIteration={() => setN((x) => x + 1)} />
      {b.word
        ? WORD_DOTS.map(([x, y], i) => (
            <span key={i} className="fw-dot" style={{ ...anim, left: x, top: y, background: b.color }} />
          ))
        : [
            ...Array.from({ length: SPARKS }, (_, i) => (
              <span key={`o${i}`} className="fw-arm" style={{ transform: `rotate(${(360 / SPARKS) * i}deg)` }}>
                <span className="fw-spark" style={{ ...anim, background: b.color, ["--fw-r" as string]: `${b.r}px` }} />
              </span>
            )),
            ...Array.from({ length: INNER }, (_, i) => (
              <span key={`i${i}`} className="fw-arm" style={{ transform: `rotate(${(360 / INNER) * i + 15}deg)` }}>
                <span className="fw-spark fw-spark-in" style={{ ...anim, background: "#fff8e0", ["--fw-r" as string]: `${Math.round(b.r * 0.55)}px` }} />
              </span>
            )),
          ]}
      {!b.word && <span className="fw-flash" style={{ ...anim, background: b.color }} />}
    </div>
  );
}

export function Fireworks() {
  return (
    <div data-testid="saver-fireworks" className="fw-sky absolute left-0 top-0" style={{ width: 1920, height: 1080 }}>
      {Array.from({ length: SLOTS }, (_, i) => (
        <Slot key={i} slot={i} />
      ))}
      <Skyline />
    </div>
  );
}

// «Немое кино»: a silent-comedy print — black, film grain that shifts a frame now and then
// (transform steps, no flicker), dust specks, a hairline scratch that jumps, the gate's vignette;
// sprocket holes down both edges of wide windows; dust and vignette over Home's hero.
import { rand } from "@martytv/ui/decor";
import type { WebLook } from "../look";
import "./silent.css";

function Dust({ seed, n = 14 }: { seed: number; n?: number }) {
  const r = rand(seed);
  const specks = Array.from({ length: n }, () => ({ x: r() * 1920, y: r() * 1080, rx: 1 + r() * 2.6, ry: 0.8 + r() * 1.6, o: 0.18 + r() * 0.3 }));
  return (
    <svg className="wd-fill" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice">
      {specks.map((s, i) => (
        <ellipse key={i} cx={s.x.toFixed(0)} cy={s.y.toFixed(0)} rx={s.rx.toFixed(1)} ry={s.ry.toFixed(1)} fill={i % 3 ? "#fff" : "#000"} opacity={s.o.toFixed(2)} />
      ))}
    </svg>
  );
}

function Scene() {
  return (
    <div className="sl-scene wd-fill">
      <div className="sl-grain" />
      <Dust seed={11} />
      <span className="sl-scratch" />
      <div className="sl-sprockets sl-sprockets-l wd-wide" />
      <div className="sl-sprockets sl-sprockets-r wd-wide" />
      <div className="sl-vignette wd-fill" />
    </div>
  );
}

function HeroEdges() {
  return (
    <>
      <Dust seed={5} n={10} />
      <div className="sl-vignette wd-fill" />
    </>
  );
}

export const look: WebLook = { Scene, HeroEdges };

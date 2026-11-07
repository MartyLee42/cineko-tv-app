// «Немое кино»: a silent-comedy print. Pure black and white (photos turn grey in
// silent.css), static film grain, a soft vignette and a couple of scratches;
// headings sit on intertitle cards in an art-nouveau frame (CSS border-image).
// No projector flicker. The only motion: the iris-in on the focused card, off in the calm mode (html.sl-calm).
import "./silent.css";
import { useEffect } from "react";
import type { Look } from "./types";
import { layer, rand } from "./common";

/** A few dust specks and two hairline scratches (static, deterministic). */
function Dust({ w, h, seed }: { w: number; h: number; seed: number }) {
  const r = rand(seed);
  const specks = Array.from({ length: 14 }, () => ({ x: r() * w, y: r() * h, rx: 1 + r() * 2.6, ry: 0.8 + r() * 1.6, o: 0.18 + r() * 0.3 }));
  const x1 = Math.round(w * (0.18 + r() * 0.2));
  const x2 = Math.round(w * (0.7 + r() * 0.2));
  return (
    <svg className="absolute left-0 top-0" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      {specks.map((s, i) => (
        <ellipse key={i} cx={s.x.toFixed(0)} cy={s.y.toFixed(0)} rx={s.rx.toFixed(1)} ry={s.ry.toFixed(1)} fill={i % 3 ? "#fff" : "#000"} opacity={s.o.toFixed(2)} />
      ))}
      <path d={`M${x1} 0 L${x1 + 6} ${h * 0.55} L${x1 + 3} ${h}`} stroke="#fff" strokeOpacity=".16" strokeWidth="1.4" fill="none" />
      <path d={`M${x2} ${h * 0.1} L${x2 - 4} ${h * 0.8}`} stroke="#fff" strokeOpacity=".1" strokeWidth="1" fill="none" />
    </svg>
  );
}

/** The screen: black, grain, vignette, dust. Also tells the CSS when motion is calm (no iris). */
function FilmBackground({ calm, dim }: { calm: boolean; dim: boolean }) {
  useEffect(() => {
    const html = document.documentElement;
    html.classList.toggle("sl-calm", calm);
    return () => html.classList.remove("sl-calm");
  }, [calm]);
  return (
    <div data-skin-bg="intertitle" className={`sl-film ${layer}`}>
      <div className="sl-grain absolute left-0 top-0 h-full w-full" />
      {!dim && <Dust w={1920} h={1080} seed={11} />}
      <div className="sl-vignette absolute left-0 top-0 h-full w-full" />
    </div>
  );
}

/** Over Home's artwork: dust and the gate's vignette (the grain rides on the scrim). */
function FilmHeroEdges({ height }: { height: number }) {
  return (
    <div className="pointer-events-none absolute left-0 top-0 w-full" style={{ height }}>
      <Dust w={1920} h={height} seed={5} />
      <div className="sl-vignette absolute left-0 top-0 h-full w-full" />
    </div>
  );
}

export const look: Look = { Background: FilmBackground, HeroEdges: FilmHeroEdges };

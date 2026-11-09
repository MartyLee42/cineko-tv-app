// «Ар-деко»: black lacquer with gold sunburst fans in the corners and faint pinstripes;
// over Home's hero a red velvet curtain at the right and a gold-edged valance on top.
import type { WebLook } from "../look";
import "./deco.css";

const RAYS = Array.from({ length: 13 }, (_, i) => (i * Math.PI) / 2 / 12);

/** A quarter sunburst fan anchored at its top-left corner (rays and stepped arcs); flipped by CSS. */
function DecoFan({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 200 200">
      <g fill="none" stroke="#c9a54c" strokeWidth="1.4" vectorEffect="non-scaling-stroke">
        {[60, 110, 150, 186].map((r) => (
          <path key={r} d={`M ${r} 0 A ${r} ${r} 0 0 1 0 ${r}`} vectorEffect="non-scaling-stroke" />
        ))}
        {RAYS.map((a, i) => (
          <line key={i} x1={Math.cos(a) * 60} y1={Math.sin(a) * 60} x2={Math.cos(a) * (i % 2 ? 150 : 186)} y2={Math.sin(a) * (i % 2 ? 150 : 186)} vectorEffect="non-scaling-stroke" />
        ))}
        <path d="M 0 30 L 30 30 L 30 0" vectorEffect="non-scaling-stroke" />
        <path d="M 0 42 L 42 42 L 42 0" vectorEffect="non-scaling-stroke" />
      </g>
      <path d="M 0 0 L 22 0 A 22 22 0 0 1 0 22 Z" fill="#c9a54c" />
    </svg>
  );
}

function Scene() {
  return (
    <div className="dc-scene wd-fill">
      <DecoFan className="dc-fan dc-fan-tr" />
      <DecoFan className="dc-fan dc-fan-bl" />
      <DecoFan className="dc-fan dc-fan-br wd-wide" />
      <div className="dc-frame" />
    </div>
  );
}

function HeroEdges() {
  return (
    <>
      <div className="dc-curtain" />
      <div className="dc-valance" />
    </>
  );
}

export const look: WebLook = { Scene, HeroEdges };

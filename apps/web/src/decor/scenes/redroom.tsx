// «Красная комната»: red velvet everywhere — deep curtain folds on the back wall, wide draped
// curtains with a swagged valance framing wide windows (index.css keeps slim drapes and the
// zigzag floor over the page on every width), a cup of coffee and a slice of cherry pie at the
// curtains' feet; the room's light falls off towards the hero's edges. Static.
import type { WebLook } from "../look";
import "./redroom.css";

/** A curtain's inner edge with gentle scallops (a 90×1080 strip, left side; the right one is mirrored by CSS). */
const CURTAIN = (() => {
  const pts: string[] = [];
  for (let y = 0; y <= 1080; y += 60) pts.push(`${(y / 60) % 2 ? 90 : 83} ${y}`);
  return `M0 0 L${pts.join(" L")} L0 1080 Z`;
})();

function Curtain({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 90 1080" preserveAspectRatio="none">
      <defs>
        <linearGradient id="rrw-fold" x1="0" y1="0" x2="26" y2="0" gradientUnits="userSpaceOnUse" spreadMethod="repeat">
          <stop offset="0" stopColor="#4a0306" />
          <stop offset="0.35" stopColor="#b3121c" />
          <stop offset="0.55" stopColor="#d21f2a" />
          <stop offset="1" stopColor="#4a0306" />
        </linearGradient>
        <linearGradient id="rrw-shade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="rgba(0,0,0,0)" />
          <stop offset="1" stopColor="rgba(0,0,0,.5)" />
        </linearGradient>
      </defs>
      <path d={CURTAIN} fill="url(#rrw-fold)" />
      <path d={CURTAIN} fill="url(#rrw-shade)" />
    </svg>
  );
}

function Coffee() {
  return (
    <svg className="rr-prop rr-coffee" viewBox="-40 -72 80 84">
      <path d="M-14 -40 C -20 -48 -8 -54 -14 -62 M0 -42 C -6 -52 6 -58 0 -68" fill="none" stroke="rgba(240,236,228,.55)" strokeWidth="3" strokeLinecap="round" />
      <ellipse cx="0" cy="2" rx="34" ry="8" fill="#e9e4da" stroke="#1a0b0b" strokeWidth="2" />
      <path d="M-22 -30 L22 -30 L18 -4 C 16 2 -16 2 -18 -4 Z" fill="#f4efe6" stroke="#1a0b0b" strokeWidth="2" strokeLinejoin="round" />
      <path d="M21 -24 C 34 -24 34 -10 19 -10" fill="none" stroke="#f4efe6" strokeWidth="5" />
      <ellipse cx="0" cy="-30" rx="22" ry="5" fill="#2a160c" stroke="#1a0b0b" strokeWidth="2" />
    </svg>
  );
}

function Pie() {
  return (
    <svg className="rr-prop rr-pie" viewBox="-42 -46 84 58">
      <ellipse cx="0" cy="2" rx="38" ry="9" fill="#e9e4da" stroke="#1a0b0b" strokeWidth="2" />
      <path d="M-30 -2 L30 -2 L26 -16 L-26 -16 Z" fill="#a8121c" stroke="#1a0b0b" strokeWidth="2" strokeLinejoin="round" />
      <path d="M-26 -16 L26 -16 L-4 -40 Z" fill="#d9a24e" stroke="#1a0b0b" strokeWidth="2" strokeLinejoin="round" />
      <path d="M-14 -16 L4 -30 M2 -16 L12 -24 M-10 -26 L14 -20" stroke="#a8742c" strokeWidth="3" strokeLinecap="round" />
      <circle cx="-16" cy="-8" r="4" fill="#e3263a" />
      <circle cx="0" cy="-9" r="4" fill="#e3263a" />
      <circle cx="16" cy="-8" r="4" fill="#e3263a" />
    </svg>
  );
}

function Scene() {
  return (
    <div className="rr-scene wd-fill">
      <div className="rr-wide">
        <Curtain className="rr-curtain rr-curtain-l" />
        <Curtain className="rr-curtain rr-curtain-r" />
        <div className="rr-valance" />
        <Pie />
        <Coffee />
      </div>
    </div>
  );
}

function HeroEdges() {
  return <div className="rr-vignette" />;
}

export const look: WebLook = { Scene, HeroEdges };

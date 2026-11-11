// «Пять звёзд»: a city at sunset — a low sun behind the towers, palms, an elevated freeway
// whose traffic slides by (transform only); over Home's hero a sunset grade, a halftone corner
// and a diagonal gutter like a panel of a game's box art.
import { palm, starField, towers } from "@martytv/ui/decor";
import type { WebLook } from "../look";
import "./fivestars.css";

const FAR = towers(7, -20, 1940, 905, 150, 430, 6);
const NEAR = towers(19, -30, 1950, 1080, 110, 300, 8);
const WINDOW = ["#ffd38a", "#ff7ab6", "#8ff3ff"];
const STARS = starField(40, 11, 1920, 360);
const PALMS = [palm(78, 1080, 600, 46), palm(236, 1080, 430, -34), palm(1856, 1080, 640, -58)];
const PILLARS = Array.from({ length: 13 }, (_, i) => i * 160 + 40);
const LIGHTS = [60, 210, 330, 520, 700, 860, 1010, 1190, 1330, 1500, 1660, 1810];

function Lane({ y, fill }: { y: number; fill: string }) {
  return (
    <>
      {[0, 1920].map((off) => (
        <g key={off} transform={`translate(${off} 0)`}>
          {LIGHTS.map((x, i) => (
            <rect key={x} x={x} y={y} width={i % 3 ? 24 : 36} height="3" rx="1.5" fill={fill} />
          ))}
        </g>
      ))}
    </>
  );
}

function Scene() {
  return (
    <div className="fs-scene wd-fill">
      <svg className="fs-city" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
        <g fill="#fff5ec">
          {STARS.map((s, i) => (
            <circle key={i} cx={s.x} cy={s.y} r={s.r * 0.8} opacity={s.o * 0.55} />
          ))}
        </g>
        <circle cx="1380" cy="790" r="200" fill="url(#fs-web-sun)" opacity=".55" />
        <defs>
          <radialGradient id="fs-web-sun" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#fff1b0" />
            <stop offset="0.5" stopColor="#ffb85a" />
            <stop offset="1" stopColor="#ff4f86" />
          </radialGradient>
        </defs>
        {FAR.map((b) => (
          <g key={b.x}>
            <rect x={b.x} y={905 - b.h} width={b.w} height={b.h} fill="#3b1752" />
            {b.antenna && <rect x={b.x + b.w / 2 - 2} y={905 - b.h - 46} width="4" height="46" fill="#3b1752" />}
            {b.antenna && <circle cx={b.x + b.w / 2} cy={905 - b.h - 48} r="4" fill="#ff4a5a" />}
            {b.win.map((w, i) => (
              <rect key={i} x={w.x} y={w.y} width="6" height="9" fill={WINDOW[w.c]} opacity=".45" />
            ))}
          </g>
        ))}
        <rect x="0" y="934" width="1920" height="26" fill="#12081d" />
        <rect x="0" y="934" width="1920" height="3" fill="#ff6a8f" opacity=".7" />
        {PILLARS.map((x) => (
          <rect key={x} x={x} y="960" width="22" height="120" fill="#12081d" />
        ))}
        <g className="fs-drive-r">
          <Lane y={941} fill="#fff2d6" />
        </g>
        <g transform="translate(-1920 0)">
          <g className="fs-drive-l">
            <Lane y={950} fill="#ff4a5a" />
          </g>
        </g>
        {NEAR.map((b) => (
          <g key={b.x}>
            <rect x={b.x} y={1080 - b.h} width={b.w} height={b.h} fill="#1a0b28" />
            {b.win.map((w, i) => (
              <rect key={i} x={w.x} y={w.y} width="6" height="9" fill={WINDOW[w.c]} opacity=".7" />
            ))}
          </g>
        ))}
        <g fill="#0b0612">
          {PALMS.map((p, i) => (
            <g key={i}>
              <path d={p.trunk} />
              {p.fronds.map((f, j) => (
                <path key={j} d={f} />
              ))}
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}

function HeroEdges() {
  return (
    <>
      <div className="fs-grade" />
      <div className="fs-dots" />
      <span className="fs-gutter" />
    </>
  );
}

export const look: WebLook = { Scene, HeroEdges };

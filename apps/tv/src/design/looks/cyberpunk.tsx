// «Киберпанк»: a neon city skyline.
import "./cyberpunk.css";
import type { Look } from "./types";
import { layer, rand } from "./common";

const SKYLINE = (() => {
  const r = rand(23);
  const blds: { x: number; w: number; h: number; win: { x: number; y: number; c: string }[] }[] = [];
  let x = 0;
  while (x < 1920) {
    const w = 50 + Math.round(r() * 90);
    const h = 90 + Math.round(r() * 260);
    const win: { x: number; y: number; c: string }[] = [];
    for (let k = 0; k < 6; k++) if (r() < 0.8) win.push({ x: x + 8 + Math.round(r() * (w - 20)), y: 1080 - h + 14 + Math.round(r() * (h - 30)), c: r() < 0.5 ? "#00f0ff" : r() < 0.6 ? "#ff2e88" : "#f5f03c" });
    blds.push({ x, w, h, win });
    x += w + 4 + Math.round(r() * 10);
  }
  return blds;
})();

/** Static: neon haze, a faint street grid, a skyline with lit windows and scanlines. */
function CityBackground() {
  return (
    <div data-skin-bg="city" className={`cp-city ${layer}`}>
      <svg className="absolute left-0 top-0 h-full w-full" viewBox="0 0 1920 1080" preserveAspectRatio="none" aria-hidden>
        {SKYLINE.map((b) => (
          <g key={b.x}>
            <rect x={b.x} y={1080 - b.h} width={b.w} height={b.h} fill="#0c0c16" stroke="#2a2a44" strokeWidth="1" />
            {b.win.map((w, i) => (
              <rect key={i} x={w.x} y={w.y} width="6" height="3" fill={w.c} opacity=".55" />
            ))}
          </g>
        ))}
      </svg>
      <div className="cp-scan absolute left-0 top-0 h-full w-full" />
    </div>
  );
}

export const look: Look = { Background: () => <CityBackground /> };

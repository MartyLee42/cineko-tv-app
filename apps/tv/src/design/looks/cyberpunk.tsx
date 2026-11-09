// «Киберпанк»: a neon city skyline.
import "./cyberpunk.css";
import type { Look } from "./types";
import { skyline } from "@martytv/ui/decor";
import { layer } from "./common";

const SKYLINE = skyline(23);

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

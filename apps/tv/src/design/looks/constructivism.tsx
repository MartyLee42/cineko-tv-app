// «Конструктивизм»: an avant-garde poster ground.
import "./constructivism.css";
import type { Look } from "./types";
import { layer } from "./common";

/** An avant-garde poster ground: a red circle at the right, crossing diagonals and wedges (static SVG). */
function PosterBackground() {
  return (
    <div data-skin-bg="poster" className={`cv-poster ${layer}`}>
      <svg className="absolute left-0 top-0" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden>
        <circle cx="1720" cy="330" r="300" fill="#d7261e" opacity=".55" />
        <circle cx="1720" cy="330" r="372" fill="none" stroke="#efe4cc" strokeWidth="3" opacity=".14" />
        <polygon points="0,1080 0,860 1180,1080" fill="#d7261e" opacity=".22" />
        <polygon points="1920,1080 1920,780 1460,1080" fill="#efe4cc" opacity=".07" />
        <line x1="-40" y1="980" x2="1960" y2="140" stroke="#efe4cc" strokeWidth="3" opacity=".1" />
        <line x1="-40" y1="1010" x2="1960" y2="170" stroke="#d7261e" strokeWidth="14" opacity=".18" />
      </svg>
    </div>
  );
}

export const look: Look = { Background: () => <PosterBackground /> };

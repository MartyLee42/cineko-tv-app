// «Тамагочи»: the page is the toy's LCD (index.css draws the pink plastic bezel). Here: the LCD's
// unlit pixel cells and a soft glare, and the toy's menu icons as faint unlit pixels along the
// top and bottom of the screen, like a real virtual pet's status bar.
import type { WebLook } from "../look";
import "./pocketpet.css";

/** 8×8 pixel icons (rows of bits): food, light, game, medicine, bath, meter, discipline, call. */
const ICONS: number[][] = [
  [0x18, 0x3c, 0x7e, 0xff, 0xff, 0x7e, 0x18, 0x18],
  [0x18, 0x3c, 0x7e, 0x7e, 0x3c, 0x18, 0x18, 0x18],
  [0x7e, 0x81, 0xa5, 0x81, 0xbd, 0x81, 0x7e, 0x00],
  [0x18, 0x18, 0x7e, 0x7e, 0x18, 0x18, 0x00, 0x00],
  [0x00, 0x24, 0x00, 0x7e, 0x81, 0x81, 0x7e, 0x00],
  [0x00, 0x7e, 0x42, 0x5a, 0x5a, 0x42, 0x7e, 0x00],
  [0x3c, 0x42, 0x02, 0x0c, 0x10, 0x00, 0x10, 0x00],
  [0x66, 0xff, 0xff, 0xff, 0x7e, 0x3c, 0x18, 0x00],
];

function iconPath(rows: number[]): string {
  let d = "";
  rows.forEach((bits, y) => {
    for (let x = 0; x < 8; x++) if (bits & (0x80 >> x)) d += `M${x} ${y}h1v1h-1z`;
  });
  return d;
}

const PATHS = ICONS.map(iconPath);

function Bar({ icons, className }: { icons: string[]; className: string }) {
  return (
    <div className={`pp-bar ${className}`}>
      {icons.map((d, i) => (
        <svg key={i} viewBox="0 0 8 8" shapeRendering="crispEdges">
          <path d={d} fill="#182012" />
        </svg>
      ))}
    </div>
  );
}

function Scene() {
  return (
    <div className="pp-scene wd-fill">
      <div className="pp-glare wd-fill" />
      <Bar icons={PATHS.slice(0, 4)} className="pp-bar-top" />
      <Bar icons={PATHS.slice(4)} className="pp-bar-bottom" />
    </div>
  );
}

export const look: WebLook = { Scene };

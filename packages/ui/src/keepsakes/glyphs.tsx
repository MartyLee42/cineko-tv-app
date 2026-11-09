// Sticker glyphs: simple flat icons in a 48×48 box, drawn from the sticker's
// palette (light paper, dark ink) plus a few fixed accents.
import type { ReactNode } from "react";
import type { Glyph, Palette } from "./stickers";

const RED = "#e8484a";
const GOLD = "#ffd34d";
const WHITE = "#fff";
const SKY = "#86cdfb";
const GREEN = "#3bb273";
const PINK = "#ffb0c4";

const ticket = (p: Palette, x = 0, y = 0, a = -12, fill = p.light) => (
  <g transform={`translate(${x} ${y}) rotate(${a} 24 24)`}>
    <path d="M6 14 H42 V20 A4 4 0 0 0 42 28 V34 H6 V28 A4 4 0 0 0 6 20 Z" fill={fill} stroke={p.ink} strokeWidth="1.5" strokeLinejoin="round" />
    <line x1="32" y1="15.5" x2="32" y2="32.5" stroke={p.ink} strokeWidth="1.4" strokeDasharray="2 2" />
    <rect x="11" y="19" width="15" height="3" rx="1.5" fill={p.ink} />
    <rect x="11" y="25" width="10" height="3" rx="1.5" fill={p.ink} opacity="0.55" />
    <circle cx="37" cy="24" r="2.2" fill={RED} />
  </g>
);

const heartPath = "M24 41 C10 31 5 24 5 16 C5 10 10 6 15 6 C19 6 22 8 24 11 C26 8 29 6 33 6 C38 6 43 10 43 16 C43 24 38 31 24 41 Z";

const star = (cx: number, cy: number, r: number, fill: string, stroke?: string) => {
  let d = "";
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 ? r * 0.45 : r;
    d += `${i ? "L" : "M"}${(cx + rr * Math.cos(a)).toFixed(1)} ${(cy + rr * Math.sin(a)).toFixed(1)} `;
  }
  return <path d={d + "Z"} fill={fill} stroke={stroke} strokeWidth={stroke ? 1.5 : undefined} strokeLinejoin="round" />;
};

const loop = (p: Palette) => (
  <>
    <path d="M38 24 A14 14 0 1 1 31 11.9" fill="none" stroke={p.light} strokeWidth="5" strokeLinecap="round" />
    <path d="M27 4 L38 10 L28 18 Z" fill={p.light} />
  </>
);

// Laurel leaves along two arcs.
const LEAVES = [0, 1, 2, 3, 4, 5].map((i) => {
  const a = Math.PI * (0.62 + i * 0.13);
  return { x: 24 + 17 * Math.cos(a), y: 25 + 17 * Math.sin(a) * -1, r: (a * 180) / Math.PI };
});

export const GLYPHS: Record<Glyph, (p: Palette) => ReactNode> = {
  ticket: (p) => ticket(p),
  tickets2: (p) => (
    <>
      {ticket(p, -4, -6, -16, PINK)}
      {ticket(p, 3, 6, 6)}
    </>
  ),
  tickets3: (p) => (
    <>
      {ticket(p, -6, -10, -20, GOLD)}
      {ticket(p, 0, -1, -6, PINK)}
      {ticket(p, 4, 9, 8)}
    </>
  ),
  // A television with cat ears: Cineko.
  tv: (p) => (
    <>
      <path d="M9 16 L13 5 L21 14 Z M27 14 L35 5 L39 16 Z" fill={p.ink} />
      <rect x="5" y="13" width="38" height="29" rx="6" fill={p.ink} />
      <rect x="9" y="17" width="25" height="21" rx="3.5" fill={p.light} />
      <rect x="14" y="23" width="4.5" height="6" rx="1.5" fill={p.ink} />
      <rect x="24" y="23" width="4.5" height="6" rx="1.5" fill={p.ink} />
      <circle cx="38.5" cy="22" r="2" fill={p.light} />
      <circle cx="38.5" cy="29" r="2" fill={RED} />
    </>
  ),
  clapper: (p) => (
    <>
      <rect x="6" y="20" width="36" height="22" rx="2.5" fill={p.ink} />
      <rect x="10" y="27" width="20" height="2.6" rx="1.3" fill={p.light} opacity="0.8" />
      <rect x="10" y="33" width="14" height="2.6" rx="1.3" fill={p.light} opacity="0.6" />
      <g transform="rotate(-16 6 19)">
        <rect x="6" y="11" width="36" height="8" rx="1.5" fill={p.light} stroke={p.ink} strokeWidth="1.5" />
        <path d="M11 11 H17 L13 19 H7 Z M23 11 H29 L25 19 H19 Z M35 11 H41 L37 19 H31 Z" fill={p.ink} />
      </g>
    </>
  ),
  clock: (p) => (
    <>
      <circle cx="24" cy="24" r="18" fill={p.light} stroke={p.ink} strokeWidth="3" />
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x="22.8" y="8.5" width="2.4" height="4" rx="1" fill={p.ink} transform={`rotate(${i * 90} 24 24)`} />
      ))}
      <path d="M24 24 V13 M24 24 L32 28" stroke={p.ink} strokeWidth="3" strokeLinecap="round" />
      <circle cx="24" cy="24" r="2.5" fill={RED} />
    </>
  ),
  sunrise: (p) => (
    <>
      {[-150, -120, -90, -60, -30].map((a) => (
        <rect key={a} x="38" y="31" width="7" height="3" rx="1.5" fill={p.light} transform={`rotate(${a} 24 32.5)`} />
      ))}
      <path d="M11 33 A13 13 0 0 1 37 33 Z" fill={WHITE} />
      <path d="M14 33 A10 10 0 0 1 34 33 Z" fill={GOLD} />
      <rect x="4" y="33" width="40" height="4" rx="2" fill={p.ink} />
      <rect x="12" y="40" width="24" height="3" rx="1.5" fill={p.ink} opacity="0.5" />
    </>
  ),
  bowl: (p) => (
    <>
      <path d="M16 15 C13 12 19 10 16 6 M24 15 C21 12 27 10 24 6" fill="none" stroke={p.light} strokeWidth="2" strokeLinecap="round" opacity="0.9" />
      <path d="M30 22 L44 5" stroke={p.ink} strokeWidth="2.5" strokeLinecap="round" />
      <path d="M33 22 L46 9" stroke={p.ink} strokeWidth="2.5" strokeLinecap="round" />
      <path d="M5 22 H43 C43 33 35 41 24 41 C13 41 5 33 5 22 Z" fill={p.light} stroke={p.ink} strokeWidth="2" />
      <path d="M10 28 H38" stroke={RED} strokeWidth="2.5" strokeLinecap="round" />
      <rect x="17" y="40" width="14" height="4" rx="2" fill={p.ink} />
    </>
  ),
  calendar: (p) => (
    <>
      <rect x="6" y="9" width="36" height="34" rx="5" fill={p.light} stroke={p.ink} strokeWidth="2" />
      <path d="M6 18 V14 A5 5 0 0 1 11 9 H37 A5 5 0 0 1 42 14 V18 Z" fill={RED} />
      <rect x="13" y="4" width="4" height="9" rx="2" fill={p.ink} />
      <rect x="31" y="4" width="4" height="9" rx="2" fill={p.ink} />
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <rect key={i} x={11 + (i % 4) * 7} y={23 + Math.floor(i / 4) * 9} width="5" height="5" rx="1.2" fill={i === 6 ? RED : p.ink} />
      ))}
    </>
  ),
  flame: () => (
    <>
      <path d="M24 3 C30 13 39 18 39 29 C39 38 32 44 24 44 C16 44 9 38 9 29 C9 22 14 18 16 11 C19 17 21 19 24 20 C24 14 22 9 24 3 Z" fill={GOLD} stroke="#c2410c" strokeWidth="2" strokeLinejoin="round" />
      <path d="M24 22 C28 28 32 30 32 35 C32 39 28 42 24 42 C20 42 16 39 16 35 C16 31 20 28 24 22 Z" fill="#fff3b0" />
    </>
  ),
  tree: (p) => (
    <>
      <rect x="21" y="37" width="6" height="7" rx="1" fill="#8a5a3c" />
      <path d="M24 21 L43 38 H5 Z" fill="#bdf0c8" stroke={p.ink} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M24 13 L38 28 H10 Z" fill="#bdf0c8" stroke={p.ink} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M24 7 L33 18 H15 Z" fill="#bdf0c8" stroke={p.ink} strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="18" cy="25" r="2.2" fill={RED} />
      <circle cx="29" cy="32" r="2.2" fill={GOLD} />
      <circle cx="16" cy="34" r="2" fill={SKY} />
      <circle cx="30" cy="21" r="1.8" fill={RED} />
      {star(24, 6, 6, GOLD, "#b7791f")}
    </>
  ),
  heart: (p) => (
    <>
      <path d={heartPath} fill={RED} stroke={p.light} strokeWidth="2.5" strokeLinejoin="round" />
      <path d="M12 14 C12 11 14 10 16 10" fill="none" stroke={WHITE} strokeWidth="2.5" strokeLinecap="round" opacity="0.8" />
    </>
  ),
  // A grinning cat face.
  grin: (p) => (
    <>
      <path d="M8 18 L10 4 L20 11 Z M28 11 L38 4 L40 18 Z" fill={p.light} stroke={p.ink} strokeWidth="2" strokeLinejoin="round" />
      <circle cx="24" cy="26" r="17" fill={p.light} stroke={p.ink} strokeWidth="2" />
      <path d="M14 22 Q17 18 20 22 M28 22 Q31 18 34 22" fill="none" stroke={p.ink} strokeWidth="2.5" strokeLinecap="round" />
      <path d="M13 28 Q24 44 35 28 Z" fill={p.ink} />
      <path d="M20 35 Q24 39 28 35 Q24 33 20 35 Z" fill={RED} />
      <path d="M4 26 H11 M4 31 L11 29 M37 26 H44 M37 29 L44 31" stroke={p.ink} strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  pumpkin: () => (
    <>
      <path d="M24 12 C25 7 28 5 31 5" fill="none" stroke={GREEN} strokeWidth="3" strokeLinecap="round" />
      <ellipse cx="15" cy="28" rx="11" ry="14" fill="#e86a1f" />
      <ellipse cx="33" cy="28" rx="11" ry="14" fill="#e86a1f" />
      <ellipse cx="24" cy="28" rx="10" ry="15" fill="#ff8a3d" />
      <path d="M14 23 L19 19 L20 25 Z M34 23 L29 19 L28 25 Z" fill={GOLD} />
      <path d="M12 31 L16 33 L19 31 L22 34 L26 31 L29 34 L32 31 L36 31 C34 38 28 40 24 40 C19 40 14 38 12 31 Z" fill={GOLD} />
    </>
  ),
  projector: (p) => (
    <>
      <path d="M38 30 L48 21 V39 Z" fill={GOLD} opacity="0.75" />
      <circle cx="14" cy="13" r="8" fill={p.light} stroke={p.ink} strokeWidth="2" />
      <circle cx="29" cy="13" r="7" fill={p.light} stroke={p.ink} strokeWidth="2" />
      <circle cx="14" cy="13" r="2" fill={p.ink} />
      <circle cx="29" cy="13" r="2" fill={p.ink} />
      <rect x="6" y="22" width="30" height="17" rx="3" fill={p.ink} />
      <rect x="34" y="26" width="6" height="9" rx="1.5" fill={p.ink} />
      <circle cx="13" cy="30.5" r="3" fill={RED} />
      <rect x="20" y="28" width="11" height="2.5" rx="1.2" fill={p.light} opacity="0.7" />
      <rect x="11" y="39" width="4" height="5" fill={p.ink} />
      <rect x="27" y="39" width="4" height="5" fill={p.ink} />
    </>
  ),
  popcorn: (p) => (
    <>
      {[
        [14, 17, 6],
        [22, 12, 6.5],
        [31, 13, 6],
        [36, 19, 5],
        [11, 21, 4.5],
        [25, 18, 5.5],
      ].map(([x, y, r], i) => (
        <circle key={i} cx={x} cy={y} r={r} fill="#fff6d6" stroke={p.ink} strokeWidth="1.3" />
      ))}
      <path d="M9 21 H39 L35 45 H13 Z" fill={WHITE} stroke={p.ink} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M15 21 H20 L20 45 H16 Z M28 21 H33 L32 45 H28 Z" fill={RED} />
    </>
  ),
  remote: (p) => (
    <>
      <g transform="rotate(-22 22 26)">
        <rect x="14" y="6" width="17" height="40" rx="7" fill={p.light} stroke={p.ink} strokeWidth="2" />
        <circle cx="22.5" cy="14" r="3.5" fill={RED} />
        <circle cx="22.5" cy="25" r="4.5" fill={p.ink} />
        <circle cx="22.5" cy="25" r="1.6" fill={p.light} />
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={18 + (i % 2) * 6} y={33 + Math.floor(i / 2) * 5} width="3.5" height="3" rx="1" fill={p.ink} opacity="0.7" />
        ))}
      </g>
      <text x="40" y="12" fontSize="10" fontWeight="900" fill={p.light}>
        z
      </text>
      <text x="44" y="5" fontSize="7" fontWeight="900" fill={p.light} opacity="0.8">
        z
      </text>
    </>
  ),
  paw: (p) => (
    <>
      <path d="M24 24 C31 24 37 30 37 36 C37 41 33 43 29 42 C26 41 22 41 19 42 C15 43 11 41 11 36 C11 30 17 24 24 24 Z" fill={p.light} />
      <ellipse cx="10" cy="20" rx="4.5" ry="5.5" fill={p.light} transform="rotate(-20 10 20)" />
      <ellipse cx="18" cy="11" rx="4.5" ry="5.8" fill={p.light} transform="rotate(-8 18 11)" />
      <ellipse cx="30" cy="11" rx="4.5" ry="5.8" fill={p.light} transform="rotate(8 30 11)" />
      <ellipse cx="38" cy="20" rx="4.5" ry="5.5" fill={p.light} transform="rotate(20 38 20)" />
      <text x="24" y="39" textAnchor="middle" fontSize="11" fontWeight="900" fill={p.ink}>
        9
      </text>
    </>
  ),
  hourglass: (p) => (
    <>
      <path d="M13 9 H35 C35 18 26 21 26 24 C26 27 35 30 35 39 H13 C13 30 22 27 22 24 C22 21 13 18 13 9 Z" fill={p.light} stroke={p.ink} strokeWidth="1.5" />
      <path d="M16.5 12 H31.5 C30.5 16.5 25.5 19 24 22 C22.5 19 17.5 16.5 16.5 12 Z" fill={GOLD} />
      <path d="M15.5 37 C17 31 22 29.5 24 28.5 C26 29.5 31 31 32.5 37 Z" fill={GOLD} />
      <rect x="8" y="5" width="32" height="5" rx="2.5" fill={p.ink} />
      <rect x="8" y="38" width="32" height="5" rx="2.5" fill={p.ink} />
    </>
  ),
  // A bowler hat and a toothbrush moustache: the silent era.
  bowler: (p) => (
    <>
      <path d="M11 25 C11 11 37 11 37 25 Z" fill={p.light} />
      <rect x="11" y="21" width="26" height="4" fill={RED} />
      <ellipse cx="24" cy="26" rx="18" ry="3.6" fill={p.light} />
      <rect x="19" y="35" width="10" height="4" rx="1" fill={p.light} />
      <path d="M32 40 C32 34 38 33 38 38 V46" fill="none" stroke={p.light} strokeWidth="2.5" strokeLinecap="round" />
    </>
  ),
  ghost: (p) => (
    <>
      <path d="M10 43 V22 C10 12 16 5 24 5 C32 5 38 12 38 22 V43 L33 39 L28.5 43 L24 39 L19.5 43 L15 39 Z" fill={WHITE} />
      <ellipse cx="18.5" cy="21" rx="3" ry="4" fill={p.ink} />
      <ellipse cx="29.5" cy="21" rx="3" ry="4" fill={p.ink} />
      <ellipse cx="24" cy="31" rx="3.5" ry="4.5" fill={p.ink} />
      <ellipse cx="13" cy="28" rx="2.5" ry="1.5" fill={PINK} opacity="0.8" />
      <ellipse cx="35" cy="28" rx="2.5" ry="1.5" fill={PINK} opacity="0.8" />
    </>
  ),
  mask_happy: (p) => (
    <>
      <path d="M7 8 C16 4 32 4 41 8 C42 26 35 41 24 43 C13 41 6 26 7 8 Z" fill={p.light} stroke={p.ink} strokeWidth="2" />
      <path d="M12 19 Q16.5 13 21 19 M27 19 Q31.5 13 36 19" fill="none" stroke={p.ink} strokeWidth="3" strokeLinecap="round" />
      <path d="M14 26 Q24 39 34 26 Q24 30 14 26 Z" fill={p.ink} />
      <circle cx="12" cy="25" r="2.5" fill={PINK} />
      <circle cx="36" cy="25" r="2.5" fill={PINK} />
    </>
  ),
  mask_sad: (p) => (
    <>
      <path d="M7 8 C16 4 32 4 41 8 C42 26 35 41 24 43 C13 41 6 26 7 8 Z" fill={p.light} stroke={p.ink} strokeWidth="2" />
      <path d="M12 17 Q16.5 22 21 17 M27 17 Q31.5 22 36 17" fill="none" stroke={p.ink} strokeWidth="3" strokeLinecap="round" />
      <path d="M15 35 Q24 26 33 35" fill="none" stroke={p.ink} strokeWidth="3" strokeLinecap="round" />
      <path d="M15 23 C13 27 13 29 15 29.5 C17 29 17 27 15 23 Z" fill={SKY} stroke="#2a7bbf" strokeWidth="0.8" />
    </>
  ),
  palette: (p) => (
    <>
      <path d="M24 5 C36 5 44 13 44 22 C44 29 38 30 34 29 C30 28 28 31 30 35 C32 40 28 43 22 43 C12 41 4 33 4 23 C4 12 13 5 24 5 Z" fill={p.light} stroke={p.ink} strokeWidth="2" />
      <circle cx="14" cy="18" r="3.6" fill={RED} />
      <circle cx="23" cy="12" r="3.6" fill={GOLD} />
      <circle cx="33" cy="14" r="3.6" fill="#3fa9f5" />
      <circle cx="38" cy="22" r="3" fill={GREEN} />
      <circle cx="16" cy="31" r="3.6" fill={p.ink} opacity="0.25" />
    </>
  ),
  camera: (p) => (
    <>
      <circle cx="12" cy="11" r="6" fill={p.light} />
      <circle cx="25" cy="11" r="6" fill={p.light} />
      <circle cx="12" cy="11" r="2" fill={p.ink} />
      <circle cx="25" cy="11" r="2" fill={p.ink} />
      <rect x="4" y="17" width="29" height="20" rx="3.5" fill={p.light} />
      <path d="M33 23 L44 17 V37 L33 31 Z" fill={p.light} />
      <circle cx="10" cy="22.5" r="2.4" fill={RED} />
      <rect x="15" y="27" width="13" height="5" rx="2" fill={p.ink} opacity="0.6" />
    </>
  ),
  rocket: (p) => (
    <>
      <path d="M19 34 L24 46 L29 34 Z" fill={GOLD} />
      <path d="M17 26 L9 37 L17 35 Z M31 26 L39 37 L31 35 Z" fill={RED} />
      <path d="M24 3 C32 10 34 21 31 34 H17 C14 21 16 10 24 3 Z" fill={p.light} stroke={p.ink} strokeWidth="1.5" />
      <circle cx="24" cy="18" r="4.5" fill={SKY} stroke={p.ink} strokeWidth="2" />
      {star(41, 7, 3.5, GOLD)}
      {star(7, 14, 2.5, GOLD)}
    </>
  ),
  hat: (p) => (
    <>
      <path d="M13 27 C13 14 17 9 20.5 11 C22.5 12.5 25.5 12.5 27.5 11 C31 9 35 14 35 27 Z" fill="#8a5a3c" stroke={p.ink} strokeWidth="1.5" />
      <rect x="13" y="22" width="22" height="4" fill={p.ink} />
      <path d="M3 25 C9 32 39 32 45 25 C44 33 35 38 24 38 C13 38 4 33 3 25 Z" fill="#a86f45" stroke={p.ink} strokeWidth="1.5" strokeLinejoin="round" />
      {star(24, 24, 2.6, GOLD)}
    </>
  ),
  note: (p) => (
    <>
      <path d="M18 34 V11 L40 6 V30" fill="none" stroke={p.light} strokeWidth="3.5" strokeLinejoin="round" />
      <path d="M18 11 L40 6 V13 L18 18 Z" fill={p.light} />
      <ellipse cx="13" cy="35" rx="6.5" ry="5" fill={p.light} transform="rotate(-20 13 35)" />
      <ellipse cx="35" cy="31" rx="6.5" ry="5" fill={p.light} transform="rotate(-20 35 31)" />
    </>
  ),
  helmet: (p) => (
    <>
      <path d="M5 31 C5 16 13 7 24 7 C35 7 43 16 43 31 Z" fill={p.light} stroke={p.ink} strokeWidth="2" />
      <path d="M12 18 C15 13 19 11 23 11" fill="none" stroke={WHITE} strokeWidth="2.5" strokeLinecap="round" />
      <rect x="1" y="30" width="46" height="6" rx="3" fill={p.ink} />
      {star(24, 21, 6, RED)}
      <path d="M10 36 C12 42 16 44 20 44" fill="none" stroke={p.ink} strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  hearts: (p) => (
    <>
      <path d={heartPath} fill={PINK} stroke={p.ink} strokeWidth="2" transform="translate(16 2) scale(0.6)" />
      <path d={heartPath} fill={RED} stroke={p.light} strokeWidth="2.5" transform="translate(1 9) scale(0.8)" />
    </>
  ),
  fedora: (p) => (
    <>
      <path d="M11 27 C11 17 15 10 20 11 C22 13 26 13 28 11 C33 10 37 17 37 27 Z" fill={p.ink} />
      <path d="M20 11 C22 15 26 15 28 11" fill="none" stroke={p.light} strokeWidth="1" opacity="0.4" />
      <rect x="11" y="22" width="26" height="4.5" fill={GOLD} />
      <path d="M2 28 C10 25 38 25 46 28 C44 32 36 34 24 34 C12 34 4 32 2 28 Z" fill={p.ink} />
      <path d="M17 41 H31" stroke={p.light} strokeWidth="2.5" strokeLinecap="round" opacity="0.7" />
    </>
  ),
  magnifier: (p) => (
    <>
      <path d="M30 30 L42 42" stroke={p.light} strokeWidth="7" strokeLinecap="round" />
      <circle cx="20" cy="20" r="13" fill="#d8f1ff" stroke={p.light} strokeWidth="4" />
      <text x="20" y="26.5" textAnchor="middle" fontSize="17" fontWeight="900" fill={p.ink}>
        ?
      </text>
    </>
  ),
  castle: (p) => (
    <>
      <path d="M5 18 L10.5 7 L16 18 Z M32 18 L37.5 7 L43 18 Z" fill={RED} />
      <path d="M6 44 V18 H15 V44 Z M33 44 V18 H42 V44 Z" fill={p.light} stroke={p.ink} strokeWidth="1.5" />
      <path d="M14 44 V24 H17 V21 H21 V24 H27 V21 H31 V24 H34 V44 Z" fill={p.light} stroke={p.ink} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M20 44 V36 A4 4 0 0 1 28 36 V44 Z" fill={p.ink} />
      <rect x="9" y="24" width="3" height="5" rx="1.5" fill={p.ink} />
      <rect x="36" y="24" width="3" height="5" rx="1.5" fill={p.ink} />
      <path d="M37.5 7 V2 L42 3.5 L37.5 5" fill={GOLD} stroke={GOLD} strokeWidth="1" />
    </>
  ),
  column: (p) => (
    <>
      <path d="M5 11 H43 L39 6 H9 Z" fill={p.light} stroke={p.ink} strokeWidth="1.5" strokeLinejoin="round" />
      <rect x="9" y="11" width="30" height="4" fill={p.light} stroke={p.ink} strokeWidth="1.5" />
      <rect x="13" y="15" width="22" height="22" fill={p.light} stroke={p.ink} strokeWidth="1.5" />
      <path d="M18 17 V35 M24 17 V35 M30 17 V35" stroke={p.ink} strokeWidth="1.5" opacity="0.45" />
      <rect x="9" y="37" width="30" height="4" fill={p.light} stroke={p.ink} strokeWidth="1.5" />
      <rect x="6" y="41" width="36" height="4" rx="1" fill={p.light} stroke={p.ink} strokeWidth="1.5" />
    </>
  ),
  house: (p) => (
    <>
      <rect x="31" y="8" width="5" height="10" fill={p.ink} />
      <rect x="9" y="22" width="30" height="21" fill={p.light} stroke={p.ink} strokeWidth="1.5" />
      <path d="M3 24 L24 6 L45 24 Z" fill={RED} stroke={p.ink} strokeWidth="1.5" strokeLinejoin="round" />
      <rect x="27" y="31" width="8" height="12" rx="1" fill="#8a5a3c" />
      <rect x="13" y="28" width="9" height="8" rx="1" fill={SKY} stroke={p.ink} strokeWidth="1.2" />
      <path d={heartPath} fill={RED} transform="translate(14.5 29.5) scale(0.13)" />
    </>
  ),
  bolt: (p) => <path d="M29 3 L9 27 H22 L17 45 L39 18 H26 Z" fill={GOLD} stroke={p.ink} strokeWidth="2.2" strokeLinejoin="round" />,
  burst: (p) => {
    let d = "";
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      const r = i % 2 ? 12 : 22;
      d += `${i ? "L" : "M"}${(24 + r * Math.cos(a)).toFixed(1)} ${(24 + r * Math.sin(a)).toFixed(1)} `;
    }
    return (
      <>
        <path d={d + "Z"} fill="#fff3b0" stroke={p.ink} strokeWidth="1.5" strokeLinejoin="round" />
        <circle cx="24" cy="24" r="9" fill={RED} />
        <text x="24" y="29" textAnchor="middle" fontSize="14" fontWeight="900" fill={WHITE}>
          !
        </text>
      </>
    );
  },
  compass: (p) => (
    <>
      <circle cx="24" cy="24" r="19" fill={p.light} stroke={p.ink} strokeWidth="3" />
      <path d="M24 7 L29.5 24 H18.5 Z" fill={RED} />
      <path d="M24 41 L18.5 24 H29.5 Z" fill={p.ink} />
      <circle cx="24" cy="24" r="2.5" fill={p.light} stroke={p.ink} strokeWidth="1.5" />
    </>
  ),
  cocktail: (p) => (
    <>
      <path d="M30 4 L22 22" stroke={p.ink} strokeWidth="2" strokeLinecap="round" />
      <path d="M6 10 H42 L24 28 Z" fill={p.light} stroke={p.ink} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M11 14 H37 L24 26 Z" fill={PINK} />
      <path d="M24 28 V40" stroke={p.light} strokeWidth="3" />
      <ellipse cx="24" cy="41" rx="9" ry="2.5" fill={p.light} />
      <circle cx="35" cy="9" r="4" fill={RED} />
      <circle cx="13" cy="9" r="3" fill={GOLD} />
    </>
  ),
  bubbles: (p) => (
    <>
      <path d="M4 7 H27 A4 4 0 0 1 31 11 V23 A4 4 0 0 1 27 27 H14 L8 33 V27 H4 A4 4 0 0 1 0 23 V11 A4 4 0 0 1 4 7 Z" fill={p.light} />
      <path d="M21 19 H44 A4 4 0 0 1 48 23 V35 A4 4 0 0 1 44 39 H40 V45 L34 39 H21 A4 4 0 0 1 17 35 V23 A4 4 0 0 1 21 19 Z" fill={GOLD} />
      <circle cx="9" cy="17" r="2" fill={p.ink} />
      <circle cx="15.5" cy="17" r="2" fill={p.ink} />
      <circle cx="26" cy="29" r="2" fill={p.ink} />
      <circle cx="32.5" cy="29" r="2" fill={p.ink} />
      <circle cx="39" cy="29" r="2" fill={p.ink} />
    </>
  ),
  taeguk: (p) => (
    <>
      <circle cx="24" cy="24" r="19" fill={WHITE} stroke={p.ink} strokeWidth="2" />
      <path d="M7 24 A17 17 0 0 1 41 24 A8.5 8.5 0 0 1 24 24 A8.5 8.5 0 0 0 7 24 Z" fill="#d6283a" />
      <path d="M7 24 A8.5 8.5 0 0 0 24 24 A8.5 8.5 0 0 1 41 24 A17 17 0 0 1 7 24 Z" fill="#1f4fa8" />
    </>
  ),
  torii: (p) => (
    <>
      <circle cx="24" cy="30" r="12" fill={WHITE} opacity="0.9" />
      <path d="M2 9 Q24 14 46 9 L45 15 Q24 18 3 15 Z" fill="#d6283a" stroke={p.ink} strokeWidth="1" />
      <rect x="8" y="20" width="32" height="4" fill="#d6283a" />
      <rect x="12" y="15" width="5" height="30" fill="#d6283a" />
      <rect x="31" y="15" width="5" height="30" fill="#d6283a" />
      <rect x="22" y="16" width="4" height="5" fill="#d6283a" />
    </>
  ),
  lotus: (p) => (
    <>
      {[-70, -35, 35, 70].map((a) => (
        <path key={a} d="M24 9 C30 17 30 29 24 37 C18 29 18 17 24 9 Z" fill={Math.abs(a) > 50 ? PINK : "#ffd1dc"} stroke={p.ink} strokeWidth="1.3" transform={`rotate(${a} 24 37)`} />
      ))}
      <path d="M24 9 C30 17 30 29 24 37 C18 29 18 17 24 9 Z" fill={p.light} stroke={p.ink} strokeWidth="1.3" />
      <path d="M6 41 Q15 38 24 41 Q33 44 42 41" fill="none" stroke={p.light} strokeWidth="2.5" strokeLinecap="round" />
    </>
  ),
  eiffel: (p) => (
    <>
      <path d="M24 2 L26.5 15 H21.5 Z" fill={p.light} />
      <rect x="19" y="15" width="10" height="3" fill={p.light} />
      <path d="M20.5 18 H27.5 L31 29 H17 Z" fill={p.light} />
      <rect x="14" y="29" width="20" height="3.5" fill={p.light} />
      <path d="M15.5 32.5 H32.5 L41 45 H33 C31 39 27.5 37 24 37 C20.5 37 17 39 15 45 H7 Z" fill={p.light} />
      <path d="M22 21 L26 26 M26 21 L22 26" stroke={p.ink} strokeWidth="1" opacity="0.6" />
      <circle cx="9" cy="10" r="1.6" fill={GOLD} />
      <circle cx="40" cy="15" r="1.3" fill={GOLD} />
    </>
  ),
  pizza: (p) => (
    <>
      <path d="M5 9 Q24 1 43 9 L24 45 Z" fill={GOLD} stroke={p.ink} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M5 9 Q24 1 43 9" fill="none" stroke="#d9913a" strokeWidth="6" strokeLinecap="round" />
      <circle cx="17" cy="15" r="3" fill={RED} />
      <circle cx="29" cy="16" r="3" fill={RED} />
      <circle cx="23" cy="26" r="3" fill={RED} />
      <circle cx="25" cy="35" r="2.2" fill={RED} />
      <circle cx="33" cy="22" r="1.4" fill={GREEN} />
      <circle cx="15" cy="21" r="1.4" fill={GREEN} />
    </>
  ),
  fan: (p) => (
    <>
      <path d="M24 40 L3 20 A28 28 0 0 1 45 20 Z" fill={RED} stroke={p.ink} strokeWidth="1.5" strokeLinejoin="round" />
      {[-60, -40, -20, 0, 20, 40, 60].map((a) => (
        <line key={a} x1="24" y1="40" x2="24" y2="14" stroke={p.light} strokeWidth="1.3" transform={`rotate(${a} 24 40)`} opacity="0.85" />
      ))}
      <path d="M7 19 A24 24 0 0 1 41 19" fill="none" stroke={GOLD} strokeWidth="2.5" />
      <circle cx="24" cy="40" r="3" fill={p.ink} />
    </>
  ),
  lantern: (p) => (
    <>
      <path d="M24 1 V6" stroke={p.ink} strokeWidth="2" />
      <rect x="16" y="5" width="16" height="4" rx="1.5" fill={p.ink} />
      <ellipse cx="24" cy="23" rx="16" ry="14" fill={GOLD} stroke={p.ink} strokeWidth="1.5" />
      <path d="M24 9 C17 14 17 32 24 37 M24 9 C31 14 31 32 24 37" fill="none" stroke="#c2410c" strokeWidth="1.5" />
      <rect x="16" y="36" width="16" height="4" rx="1.5" fill={p.ink} />
      <path d="M21 40 V47 M24 40 V47 M27 40 V47" stroke={GOLD} strokeWidth="1.6" />
    </>
  ),
  star5: (p) => star(24, 25, 21, GOLD, p.ink),
  sakura: () => (
    <>
      {[0, 72, 144, 216, 288].map((a) => (
        <path key={a} d="M24 24 C17 17 18 7 24 5 C27 8 26 6 28 5 C33 9 31 18 24 24 Z" fill="#ffd1dc" stroke="#e46b8c" strokeWidth="1.2" transform={`rotate(${a} 24 24)`} />
      ))}
      <circle cx="24" cy="24" r="4" fill={GOLD} />
    </>
  ),
  globe: (p) => (
    <>
      <circle cx="24" cy="24" r="19" fill={SKY} stroke={p.ink} strokeWidth="2.5" />
      <path d="M12 13 C17 11 21 14 19 19 C17 23 21 25 18 30 C14 31 9 26 8 21 C8 18 10 15 12 13 Z" fill={GREEN} />
      <path d="M29 9 C33 10 38 14 40 19 C37 21 33 18 31 22 C29 26 34 30 31 36 C28 38 25 34 26 28 C27 23 24 20 25 15 C26 12 27 10 29 9 Z" fill={GREEN} />
      <ellipse cx="24" cy="24" rx="8" ry="19" fill="none" stroke={p.light} strokeWidth="1.3" opacity="0.7" />
      <path d="M5 24 H43" stroke={p.light} strokeWidth="1.3" opacity="0.7" />
    </>
  ),
  filmcans: (p) => (
    <>
      {[30, 19, 8].map((y, i) => (
        <g key={y} transform={`translate(${i === 1 ? 2 : i === 2 ? -1 : 0} 0)`}>
          <rect x="7" y={y + 3} width="34" height="7" fill="#aab2bd" stroke={p.ink} strokeWidth="1.5" />
          <ellipse cx="24" cy={y + 3} rx="17" ry="4" fill="#d6dbe1" stroke={p.ink} strokeWidth="1.5" />
          <ellipse cx="24" cy={y + 3} rx="4" ry="1.2" fill={p.ink} opacity="0.6" />
        </g>
      ))}
      <path d="M41 36 C46 38 46 44 40 45" fill="none" stroke={p.light} strokeWidth="2.5" strokeLinecap="round" />
    </>
  ),
  stopwatch: (p) => (
    <>
      <rect x="20" y="2" width="8" height="6" rx="1.5" fill={p.ink} />
      <rect x="35" y="10" width="6" height="4" rx="1" fill={p.ink} transform="rotate(45 38 12)" />
      <circle cx="24" cy="27" r="17" fill={p.light} stroke={p.ink} strokeWidth="3" />
      <path d="M24 27 V16" stroke={RED} strokeWidth="3" strokeLinecap="round" />
      <path d="M24 27 A11 11 0 0 1 24 16 Z" fill={RED} opacity="0.25" />
      <circle cx="24" cy="27" r="2.5" fill={p.ink} />
    </>
  ),
  spotlight: (p) => (
    <>
      <path d="M22 16 L46 40 L30 46 Z" fill={GOLD} opacity="0.6" />
      <g transform="rotate(40 16 14)">
        <rect x="6" y="8" width="20" height="13" rx="3" fill={p.light} stroke={p.ink} strokeWidth="1.5" />
        <rect x="25" y="6" width="4" height="17" rx="1.5" fill={p.ink} />
      </g>
      <path d="M8 26 L4 44 M14 30 L14 44" stroke={p.light} strokeWidth="2.5" strokeLinecap="round" />
      {star(38, 40, 5, WHITE)}
    </>
  ),
  bell: (p) => (
    <>
      <path d="M24 5 C16 5 12 11 12 19 V29 L7 35 H41 L36 29 V19 C36 11 32 5 24 5 Z" fill={GOLD} stroke={p.ink} strokeWidth="2" strokeLinejoin="round" />
      <circle cx="24" cy="39" r="4" fill={p.ink} />
      <path d="M3 13 L8 15 M4 22 H9 M45 13 L40 15 M44 22 H39" stroke={p.light} strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="35" cy="9" r="5" fill={RED} stroke={p.light} strokeWidth="1.5" />
    </>
  ),
  laurel: () => (
    <>
      {LEAVES.map((l, i) => (
        <g key={i}>
          <ellipse cx={l.x} cy={l.y} rx="5.5" ry="2.6" fill={GOLD} transform={`rotate(${-l.r + 90} ${l.x} ${l.y})`} />
          <ellipse cx={48 - l.x} cy={l.y} rx="5.5" ry="2.6" fill={GOLD} transform={`rotate(${l.r - 90} ${48 - l.x} ${l.y})`} />
        </g>
      ))}
      {star(24, 22, 9, WHITE)}
      <path d="M17 42 Q24 38 31 42" fill="none" stroke={GOLD} strokeWidth="2.5" strokeLinecap="round" />
    </>
  ),
  trash: (p) => (
    <>
      {star(30, 9, 6, GOLD, p.ink)}
      <path d="M11 17 H37 L34 44 H14 Z" fill="#d6dde6" stroke={p.ink} strokeWidth="2" strokeLinejoin="round" />
      <rect x="7" y="12" width="34" height="5" rx="2" fill="#aab2bd" stroke={p.ink} strokeWidth="2" transform="rotate(-8 24 14)" />
      <path d="M19 22 L20 40 M24 22 V40 M29 22 L28 40" stroke={p.ink} strokeWidth="1.6" opacity="0.5" />
    </>
  ),
  gem: (p) => (
    <>
      <path d="M9 17 L17 7 H31 L39 17 L24 42 Z" fill="#b9f3ff" stroke={p.ink} strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M9 17 H39 M17 7 L20 17 L24 42 L28 17 L31 7" fill="none" stroke={p.ink} strokeWidth="1.2" opacity="0.6" />
      <path d="M20 17 L24 7 L28 17 Z" fill={WHITE} opacity="0.8" />
      {star(40, 7, 3.5, WHITE)}
    </>
  ),
  // A gold statuette on a plinth.
  statuette: () => (
    <>
      <circle cx="24" cy="7" r="3.8" fill={GOLD} />
      <path d="M20 12 H28 C29 15 28 20 27 22 L27.5 34 H20.5 L21 22 C20 20 19 15 20 12 Z" fill={GOLD} />
      <path d="M20.5 14 C18 17 19 21 22 22 M27.5 14 C30 17 29 21 26 22" fill="none" stroke="#b7791f" strokeWidth="1.3" />
      <rect x="17" y="34" width="14" height="4" rx="1" fill="#b7791f" />
      <rect x="15" y="38" width="18" height="6" rx="1" fill={GOLD} />
    </>
  ),
  infinity: (p) => (
    <>
      <path d="M10 24 C10 15 19 15 24 24 C29 33 38 33 38 24 C38 15 29 15 24 24 C19 33 10 33 10 24 Z" fill="none" stroke={p.light} strokeWidth="6" strokeLinejoin="round" />
      <path d="M10 24 C10 15 19 15 24 24 C29 33 38 33 38 24" fill="none" stroke={GOLD} strokeWidth="2" opacity="0.8" />
    </>
  ),
  plane: (p) => (
    <g transform="rotate(40 24 24)">
      <path d="M24 3 C27 3 27.5 9 27.5 16 L43 26 V31 L27.5 26 V36 L33 40 V44 L24 41.5 L15 44 V40 L20.5 36 V26 L5 31 V26 L20.5 16 C20.5 9 21 3 24 3 Z" fill={p.light} stroke={p.ink} strokeWidth="1.5" strokeLinejoin="round" />
      <rect x="22.5" y="10" width="3" height="5" rx="1.5" fill={SKY} />
    </g>
  ),
  loop: (p) => loop(p),
  loop_heart: (p) => (
    <>
      {loop(p)}
      <path d={heartPath} fill={RED} transform="translate(14.5 15) scale(0.4)" />
    </>
  ),
  tomato: (p) => (
    <>
      <circle cx="24" cy="27" r="17" fill={RED} stroke={p.ink} strokeWidth="1.5" />
      <path d="M24 13 L20 6 L25 10 L30 5 L28 12 L36 11 L29 15 L33 19 L25 16 L20 20 L21 15 L13 14 Z" fill={GREEN} stroke="#1d6b3f" strokeWidth="1" strokeLinejoin="round" />
      <ellipse cx="16" cy="24" rx="3" ry="5" fill={WHITE} opacity="0.45" transform="rotate(25 16 24)" />
    </>
  ),
  // A sticker with its corner peeling.
  peel: (p) => (
    <>
      <path d="M14 7 H34 A7 7 0 0 1 41 14 V28 L28 41 H14 A7 7 0 0 1 7 34 V14 A7 7 0 0 1 14 7 Z" fill={p.light} stroke={p.ink} strokeWidth="1.5" />
      <path d="M41 28 L28 41 C27 33 33 28 41 28 Z" fill={GOLD} stroke={p.ink} strokeWidth="1.5" strokeLinejoin="round" />
      {star(22, 22, 9, RED)}
    </>
  ),
};

// «Пять звёзд»: the sticker collage on a purple grid desk (original drawings), the background of the
// TV app, the PWA and the TV intro — like a fan's desk covered in 80s crime-game merch: a big pink
// brush-script «Cineko» with a white outline and a doodled arrow, the blue comic bay (bay.tsx) as a
// tilted panel, a pink-and-black «wanted» poster, an orange «Привет из» postcard and a few rounded
// stickers, all with white sticker borders. The pieces keep to the right and the bottom: the page's
// text runs on the left. 1920 × 1080 user units; the desk grid is CSS (the caller's container).
import type { ReactNode } from "react";
import { ComicBay } from "./bay";
import { palm, starPath } from "./geometry";

const INK = "#061a35";
const PINK = "#ff5fae";
const SCRIPT = "'Pacifico', cursive";
const BLOCK = "'Oswald', 'Arial Narrow', Arial, sans-serif";
const STAR = starPath(34);
const POSTER_PALMS = [palm(70, 400, 230, 20), palm(250, 400, 190, -18)];
const CARD_PALM = palm(470, 300, 170, -20);

/** A white-bordered sticker with a soft drop shadow, at (x, y) turned by `r` degrees. */
function Sticker({ x, y, w, h, r, rx = 10, children }: { x: number; y: number; w: number; h: number; r: number; rx?: number; children: ReactNode }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${r})`}>
      <rect x="-4" y="6" width={w + 20} height={h + 20} rx={rx + 4} fill="#000" opacity=".28" />
      <rect x="-10" y="-10" width={w + 20} height={h + 20} rx={rx + 4} fill="#ffffff" />
      {children}
    </g>
  );
}

/** A rounded icon sticker (120 × 120): a colour tile and an ink pictogram. */
function IconSticker({ x, y, r, fill, children }: { x: number; y: number; r: number; fill: string; children: ReactNode }) {
  return (
    <Sticker x={x} y={y} w={120} h={120} r={r} rx={22}>
      <rect x="0" y="0" width="120" height="120" rx="20" fill={fill} stroke={INK} strokeWidth="4" />
      {children}
    </Sticker>
  );
}

export function StickerDesk({ calm = false, dim = false, className, width = 1920, height = 1080, preserveAspectRatio }: { calm?: boolean; dim?: boolean; className?: string; width?: number | string; height?: number | string; preserveAspectRatio?: string }) {
  return (
    <svg className={className} width={width} height={height} viewBox="0 0 1920 1080" preserveAspectRatio={preserveAspectRatio} aria-hidden="true">
      {/* The big pink script with a white outline and an ink shadow, a swoosh under it. */}
      <g transform="translate(1180 230) rotate(-8)" opacity={dim ? 0.35 : 1}>
        <text x="8" y="10" fontFamily={SCRIPT} fontSize="190" fill={INK} opacity=".55">
          Cineko
        </text>
        <text x="0" y="0" fontFamily={SCRIPT} fontSize="190" fill={PINK} stroke="#ffffff" strokeWidth="16" strokeLinejoin="round" paintOrder="stroke">
          Cineko
        </text>
        <path d="M30 56 C 220 40 420 30 640 46" fill="none" stroke="#ffffff" strokeWidth="22" strokeLinecap="round" />
        <path d="M30 56 C 220 40 420 30 640 46" fill="none" stroke={PINK} strokeWidth="10" strokeLinecap="round" />
      </g>
      {!dim && (
        <>
          {/* A doodled arrow from the script down to the bay. */}
          <path d="M1060 330 C 1000 380 1010 470 1110 480 M1086 456 L1112 482 L1078 494" fill="none" stroke="#ffffff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" opacity=".9" />
          {/* The blue comic bay. */}
          <Sticker x={1150} y={330} w={640} h={360} r={4}>
            <ComicBay calm={calm} width={640} height={360} />
          </Sticker>
          {/* The «wanted» poster: pink duotone, ink silhouettes, a black title band. */}
          <Sticker x={1560} y={700} w={300} h={400} r={-6} rx={4}>
            <rect x="0" y="0" width="300" height="400" fill="#ff8ccc" />
            <circle cx="210" cy="190" r="70" fill="none" stroke="#111" strokeWidth="10" />
            <g fill="#111">
              <rect x="0" y="300" width="300" height="100" />
              <rect x="150" y="250" width="40" height="60" />
              <rect x="196" y="226" width="50" height="84" />
              <rect x="252" y="262" width="48" height="48" />
              {POSTER_PALMS.map((p, i) => (
                <g key={i}>
                  <path d={p.trunk} />
                  {p.fronds.map((f, j) => (
                    <path key={j} d={f} />
                  ))}
                </g>
              ))}
              <rect x="0" y="0" width="300" height="64" />
            </g>
            <text x="150" y="44" textAnchor="middle" fontFamily={BLOCK} fontWeight="700" fontSize="34" letterSpacing="2" fill="#ff8ccc">
              ПЯТЬ ЗВЁЗД
            </text>
            <g fill="#ff8ccc" transform="translate(30 352)">
              {[0, 1, 2, 3, 4].map((i) => (
                <path key={i} d={starPath(16)} transform={`translate(${i * 40 + 20} 0)`} />
              ))}
            </g>
          </Sticker>
          {/* The «Привет из» postcard: an orange sunset, a teal sea, block letters. */}
          <Sticker x={560} y={770} w={560} h={300} r={-4} rx={6}>
            <defs>
              <linearGradient id="fsc-card" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#ff5f6d" />
                <stop offset=".6" stopColor="#ffa24c" />
                <stop offset="1" stopColor="#ffd36a" />
              </linearGradient>
            </defs>
            <rect x="0" y="0" width="560" height="300" fill="url(#fsc-card)" />
            <circle cx="430" cy="220" r="80" fill="#ffe680" />
            <rect x="0" y="230" width="560" height="70" fill="#1ab0c8" />
            <g fill={INK}>
              <path d={CARD_PALM.trunk} />
              {CARD_PALM.fronds.map((f, j) => (
                <path key={j} d={f} />
              ))}
            </g>
            <text x="28" y="70" fontFamily={SCRIPT} fontSize="46" fill="#ffffff" stroke={INK} strokeWidth="6" paintOrder="stroke">
              Привет из
            </text>
            <text x="28" y="190" fontFamily={BLOCK} fontWeight="700" fontSize="124" letterSpacing="4" fill="#3c8fd6" stroke={INK} strokeWidth="6" paintOrder="stroke">
              CINEKO
            </text>
          </Sticker>
          {/* Rounded stickers: a gold star, a palm, a cassette. */}
          <IconSticker x={170} y={880} r={-8} fill="#ffa23a">
            <path d={STAR} transform="translate(60 62)" fill="#ffe14d" stroke={INK} strokeWidth="5" strokeLinejoin="round" />
          </IconSticker>
          <IconSticker x={350} y={930} r={7} fill="#ff7ac0">
            <g transform="translate(-10 0) scale(.42)" fill={INK}>
              <path d={palm(170, 270, 230, 10).trunk} />
              {palm(170, 270, 230, 10).fronds.map((f, j) => (
                <path key={j} d={f} />
              ))}
            </g>
          </IconSticker>
          <IconSticker x={1000} y={80} r={10} fill="#33c3c9">
            <g stroke={INK} strokeWidth="5" strokeLinejoin="round">
              <rect x="18" y="32" width="84" height="56" rx="6" fill="#ffffff" />
              <rect x="30" y="44" width="60" height="22" rx="4" fill="#ff5fae" />
              <circle cx="44" cy="55" r="7" fill="#ffffff" />
              <circle cx="76" cy="55" r="7" fill="#ffffff" />
            </g>
          </IconSticker>
        </>
      )}
    </svg>
  );
}
export { ComicBay } from "./bay";

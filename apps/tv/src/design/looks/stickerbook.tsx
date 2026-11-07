// «Стикербук»: a dark album board with chalk doodles; tape over Home's hero; the Details title
// on a label sticker; OK on a card peels the sticker (stickerbook.css .sb-peel).
import "./stickerbook.css";
import type { ReactNode } from "react";
import type { Look } from "./types";
import { layer } from "./common";

const CHALK = ["#ff6fa5", "#5fd3c4", "#ffd166", "#b296ff", "#fff8ef"];

/** A five-point star path around (0,0). */
function star(r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const k = i % 2 ? r * 0.45 : r;
    pts.push(`${(Math.cos(a) * k).toFixed(1)},${(Math.sin(a) * k).toFixed(1)}`);
  }
  return `M${pts.join("L")}Z`;
}

const HEART = "M0 10 C -14 0 -14 -12 -6 -14 C -2 -15 0 -12 0 -9 C 0 -12 2 -15 6 -14 C 14 -12 14 0 0 10 Z";
const SWIRL = "M0 0 C 10 -14 30 -10 28 4 C 26 16 8 16 8 6 C 8 -2 20 -2 20 4";

/** Doodles: [kind, x, y, scale, rotation, colour index]. Hand-placed, mostly on the board's edges. */
const DOODLES: [string, number, number, number, number, number][] = [
  ["star", 150, 1010, 1.2, -12, 2],
  ["heart", 560, 46, 1.1, 10, 0],
  ["swirl", 1700, 1020, 1.4, 0, 1],
  ["star", 1880, 760, 0.8, 18, 3],
  ["dot", 1240, 1050, 1, 0, 4],
  ["heart", 1020, 1030, 0.9, -14, 1],
  ["star", 760, 1040, 0.7, 30, 0],
  ["swirl", 420, 700, 1.1, 160, 3],
  ["dot", 1880, 420, 1, 0, 2],
  ["star", 1460, 1000, 1, -6, 4],
];

function Doodle({ kind, x, y, s, r, c }: { kind: string; x: number; y: number; s: number; r: number; c: string }) {
  const t = `translate(${x} ${y}) rotate(${r}) scale(${s})`;
  if (kind === "dot") return <circle cx={x} cy={y} r={5} fill={c} />;
  const d = kind === "star" ? star(20) : kind === "heart" ? HEART : SWIRL;
  return <path d={d} transform={t} fill="none" stroke={c} strokeWidth={3 / s} strokeLinecap="round" strokeLinejoin="round" />;
}

/** A die-cut sticker star (cream border, pastel fill) lying on the board. */
function StarSticker({ x, y, size, rot, fill }: { x: number; y: number; size: number; rot: number; fill: string }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`}>
      <path d={star(size)} transform="translate(2 5)" fill="rgba(0,0,0,.35)" stroke="rgba(0,0,0,.35)" strokeWidth="14" strokeLinejoin="round" />
      <path d={star(size)} fill={fill} stroke="#fffaf0" strokeWidth="12" strokeLinejoin="round" />
    </g>
  );
}

/** The album board: ink, a dot grid, chalk doodles and two star stickers. Static. */
function Board({ dim }: { dim: boolean }) {
  return (
    <div data-skin-bg="stickers" className={`sb-board ${layer}`}>
      <svg className="absolute left-0 top-0" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden>
        <g opacity={dim ? 0.12 : 0.22}>
          {DOODLES.map(([k, x, y, s, r, c], i) => (
            <Doodle key={i} kind={k} x={x} y={y} s={s} r={r} c={CHALK[c]!} />
          ))}
        </g>
        {!dim && (
          <g opacity=".9">
            <StarSticker x={1862} y={1030} size={34} rot={-14} fill="#ffd166" />
            <StarSticker x={1800} y={1062} size={20} rot={16} fill="#ff6fa5" />
          </g>
        )}
      </svg>
    </div>
  );
}

/** Over Home's hero artwork: strips of tape, as if the picture were taped into the album. */
function StickerHeroEdges() {
  return (
    <>
      <span className="sb-tape sb-tape-pink sb-hero-tape-a" />
      <span className="sb-tape sb-tape-mint sb-hero-tape-b" />
    </>
  );
}

/** Details: the title on a label sticker, the kind handwritten on it, a strip of tape on top. */
function StickerTitlePlate({ children, kind }: { children: ReactNode; kind: string }) {
  return (
    <div data-testid="sticker-label" className="sb-label relative mt-3 px-[36px] pb-[20px] pt-[22px]">
      <span className="sb-tape sb-tape-sun" style={{ left: 46, top: -18, width: 130, transform: "rotate(-5deg)" }} />
      <p className="sb-label-kind">{kind}</p>
      {children}
    </div>
  );
}

/** OK on a card: the corner curls up and the sticker lifts off (≈¼ s), then Details opens. */
const peel = {
  ms: 220,
  start(card: HTMLElement) {
    card.classList.add("sb-peel");
  },
};

export const look: Look = { Background: ({ dim }) => <Board dim={dim} />, HeroEdges: StickerHeroEdges, TitlePlate: StickerTitlePlate, pick: peel };

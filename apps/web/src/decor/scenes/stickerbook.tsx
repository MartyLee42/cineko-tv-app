// «Стикербук»: a dark album board with a dot grid, chalk doodles round the edges and two
// die-cut star stickers; over Home's hero strips of washi tape, as if the picture were taped in.
import { starPath } from "@martytv/ui/decor";
import type { WebLook } from "../look";
import "./stickerbook.css";

const CHALK = ["#ff6fa5", "#5fd3c4", "#ffd166", "#b296ff", "#fff8ef"];
const HEART = "M0 10 C -14 0 -14 -12 -6 -14 C -2 -15 0 -12 0 -9 C 0 -12 2 -15 6 -14 C 14 -12 14 0 0 10 Z";
const SWIRL = "M0 0 C 10 -14 30 -10 28 4 C 26 16 8 16 8 6 C 8 -2 20 -2 20 4";
const STAR = starPath(20);

/** Doodles in a 100×100 box per corner group: [kind, x%, y%, scale, rotation, colour]. */
type Doodle = [string, number, number, number, number, number];
const DOODLES: Doodle[] = [
  ["star", 6, 92, 1.2, -12, 2],
  ["heart", 30, 5, 1.1, 10, 0],
  ["swirl", 88, 94, 1.4, 0, 1],
  ["star", 96, 64, 0.8, 18, 3],
  ["dot", 64, 97, 1, 0, 4],
  ["heart", 52, 95, 0.9, -14, 1],
  ["star", 38, 96, 0.7, 30, 0],
  ["swirl", 3, 52, 1.1, 160, 3],
  ["dot", 97, 36, 1, 0, 2],
  ["star", 76, 90, 1, -6, 4],
  ["heart", 94, 12, 0.9, 20, 3],
  ["swirl", 14, 20, 1, 40, 2],
];

function Scene() {
  return (
    <div className="sb-scene wd-fill">
      {DOODLES.map(([k, x, y, s, r, c], i) => (
        <svg key={i} className="sb-doodle" style={{ left: `${x}%`, top: `${y}%`, transform: `translate(-50%, -50%) rotate(${r}deg) scale(${s})` }} viewBox="-30 -30 60 60">
          {k === "dot" ? (
            <circle r="5" fill={CHALK[c]} />
          ) : (
            <path d={k === "star" ? STAR : k === "heart" ? HEART : SWIRL} fill="none" stroke={CHALK[c]} strokeWidth={3 / s} strokeLinecap="round" strokeLinejoin="round" />
          )}
        </svg>
      ))}
      <svg className="sb-stickers" viewBox="0 0 140 110">
        <g transform="translate(86 56) rotate(-14)">
          <path d={starPath(34)} transform="translate(2 5)" fill="rgba(0,0,0,.35)" stroke="rgba(0,0,0,.35)" strokeWidth="14" strokeLinejoin="round" />
          <path d={starPath(34)} fill="#ffd166" stroke="#fffaf0" strokeWidth="12" strokeLinejoin="round" />
        </g>
        <g transform="translate(30 82) rotate(16)">
          <path d={starPath(20)} transform="translate(2 5)" fill="rgba(0,0,0,.35)" stroke="rgba(0,0,0,.35)" strokeWidth="12" strokeLinejoin="round" />
          <path d={starPath(20)} fill="#ff6fa5" stroke="#fffaf0" strokeWidth="10" strokeLinejoin="round" />
        </g>
      </svg>
    </div>
  );
}

function HeroEdges() {
  return (
    <>
      <span className="sb-tape sb-tape-pink sb-hero-tape-a" />
      <span className="sb-tape sb-tape-mint sb-hero-tape-b" />
    </>
  );
}

export const look: WebLook = { Scene, HeroEdges };

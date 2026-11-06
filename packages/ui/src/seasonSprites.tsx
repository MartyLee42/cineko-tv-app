// Inline SVG sprites of the season layer (no images). Each draws in its
// own small viewBox; `s` is the rendered width in px. Colours are fixed
// (they read on every design's dark background and on Кинозал light).
import type { ReactElement } from "react";

export type SpriteId =
  | "flake"
  | "flake2"
  | "snowdot"
  | "sparkle"
  | "goldstar"
  | "heart"
  | "heart2"
  | "redstar"
  | "sun"
  | "pancake"
  | "mimosa"
  | "tulip"
  | "rocket"
  | "egg1"
  | "egg2"
  | "egg3"
  | "confetti1"
  | "confetti2"
  | "confetti3"
  | "leaf1"
  | "leaf2"
  | "leaf3"
  | "bat";

type Sprite = { vb: [number, number]; draw: () => ReactElement };

const flake = (stroke: string, w: number) => (
  <g stroke={stroke} strokeWidth={w} strokeLinecap="round" fill="none">
    {[0, 60, 120].map((a) => (
      <g key={a} transform={`rotate(${a} 16 16)`}>
        <line x1="16" y1="2" x2="16" y2="30" />
        <path d="M12 6 L16 9.5 L20 6 M12 26 L16 22.5 L20 26" />
      </g>
    ))}
  </g>
);

const STAR5 = "M16 2.5 L19.9 11.6 L29.7 12.4 L22.3 18.9 L24.5 28.5 L16 23.4 L7.5 28.5 L9.7 18.9 L2.3 12.4 L12.1 11.6 Z";
const SPARKLE = "M16 1 L18.6 13.4 L31 16 L18.6 18.6 L16 31 L13.4 18.6 L1 16 L13.4 13.4 Z";
const HEART = "M16 28.5 C6.5 21 2 15.2 2 10 C2 5.9 5.1 3 8.8 3 C11.8 3 14.3 4.9 16 7.8 C17.7 4.9 20.2 3 23.2 3 C26.9 3 30 5.9 30 10 C30 15.2 25.5 21 16 28.5 Z";
const EGG = "M16 2 C23 2 28 13 28 20 C28 26.6 22.6 31 16 31 C9.4 31 4 26.6 4 20 C4 13 9 2 16 2 Z";
const MAPLE =
  "M16 1 L18.2 7.5 L21.6 5.6 L20.6 12.6 L25.8 8.2 L26.6 11.6 L31 11.2 L28.2 16 L30.6 17.6 L23.4 22.4 L24.4 25.4 L17.2 24 L17 31 L15 31 L14.8 24 L7.6 25.4 L8.6 22.4 L1.4 17.6 L3.8 16 L1 11.2 L5.4 11.6 L6.2 8.2 L11.4 12.6 L10.4 5.6 L13.8 7.5 Z";

const SPRITES: Record<SpriteId, Sprite> = {
  flake: { vb: [32, 32], draw: () => flake("#ffffff", 2.2) },
  flake2: { vb: [32, 32], draw: () => flake("#dcefff", 1.6) },
  snowdot: {
    vb: [32, 32],
    draw: () => (
      <>
        <circle cx="16" cy="16" r="9" fill="#ffffff" opacity=".9" />
        <circle cx="16" cy="16" r="14" fill="#ffffff" opacity=".18" />
      </>
    ),
  },
  sparkle: { vb: [32, 32], draw: () => <path d={SPARKLE} fill="#fff8dc" /> },
  goldstar: {
    vb: [32, 32],
    draw: () => (
      <>
        <circle cx="16" cy="16" r="15" fill="#ffd76a" opacity=".22" />
        <path d={SPARKLE} fill="#ffd76a" />
        <path d={SPARKLE} fill="#fff4c4" transform="rotate(45 16 16) scale(.55) translate(13 13)" />
      </>
    ),
  },
  heart: { vb: [32, 32], draw: () => <path d={HEART} fill="#ff4f7b" /> },
  heart2: {
    vb: [32, 32],
    draw: () => (
      <>
        <path d={HEART} fill="#ff9ab5" />
        <path d="M8 9 C8 7 9.6 6 11 6" stroke="#fff" strokeOpacity=".7" strokeWidth="2" strokeLinecap="round" fill="none" />
      </>
    ),
  },
  redstar: { vb: [32, 32], draw: () => <path d={STAR5} fill="#c8333d" stroke="#e6c46a" strokeWidth="1.2" strokeLinejoin="round" /> },
  sun: {
    vb: [40, 40],
    draw: () => (
      <>
        <g stroke="#ff9f1c" strokeWidth="3" strokeLinecap="round">
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
            <line key={a} x1="20" y1="3" x2="20" y2="8" transform={`rotate(${a} 20 20)`} />
          ))}
        </g>
        <circle cx="20" cy="20" r="10.5" fill="#ffc83d" />
        <circle cx="16.4" cy="18.4" r="1.4" fill="#b4541e" />
        <circle cx="23.6" cy="18.4" r="1.4" fill="#b4541e" />
        <path d="M15.5 22.6 Q20 26.6 24.5 22.6" stroke="#b4541e" strokeWidth="1.6" strokeLinecap="round" fill="none" />
        <circle cx="14" cy="22.2" r="1.6" fill="#ff8a5c" opacity=".7" />
        <circle cx="26" cy="22.2" r="1.6" fill="#ff8a5c" opacity=".7" />
      </>
    ),
  },
  pancake: {
    vb: [40, 40],
    draw: () => (
      <>
        <circle cx="20" cy="20" r="17" fill="#e9a54b" />
        <circle cx="20" cy="20" r="14.5" fill="#f5c46f" />
        <circle cx="14" cy="15" r="2.6" fill="#dc9238" />
        <circle cx="25" cy="13.5" r="1.8" fill="#dc9238" />
        <circle cx="26.5" cy="24" r="2.8" fill="#dc9238" />
        <circle cx="16.5" cy="26" r="1.7" fill="#dc9238" />
        <circle cx="20.5" cy="20" r="1.4" fill="#dc9238" />
        <path d="M9 17 Q11 10 18 8" stroke="#fff3cf" strokeOpacity=".6" strokeWidth="2" strokeLinecap="round" fill="none" />
      </>
    ),
  },
  mimosa: {
    vb: [32, 32],
    draw: () => (
      <>
        <path d="M6 30 Q12 18 26 6" stroke="#6f9440" strokeWidth="1.8" fill="none" strokeLinecap="round" />
        <path d="M11 22 Q8 16 10 12 M17 15 Q20 11 25 12" stroke="#6f9440" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        {[
          [10, 11, 3.2],
          [13, 8, 2.6],
          [7.5, 14.5, 2.4],
          [25, 12, 3],
          [22, 8.5, 2.6],
          [27, 5, 2.8],
          [18, 4.5, 2.4],
          [20, 13, 2.2],
          [14, 18, 2.4],
        ].map(([x, y, r], i) => (
          <circle key={i} cx={x} cy={y} r={r} fill={i % 3 === 0 ? "#ffe24d" : "#ffd21a"} />
        ))}
      </>
    ),
  },
  tulip: {
    vb: [32, 32],
    draw: () => (
      <>
        <path d="M16 31 L16 16" stroke="#4f8f3a" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M16 26 Q8 24 7 15 Q13 17 16 24" fill="#5ea547" />
        <path d="M9 4 L12.5 8 L16 3 L19.5 8 L23 4 L23 11 Q23 18 16 18 Q9 18 9 11 Z" fill="#ff4d6d" />
        <path d="M16 3 L19.5 8 L16 18 Q12.5 15 12.5 8 Z" fill="#ff7d93" opacity=".7" />
      </>
    ),
  },
  rocket: {
    vb: [72, 32],
    draw: () => (
      <>
        <path d="M2 16 Q10 10 18 13 L18 19 Q10 22 2 16 Z" fill="#ff8a2a" opacity=".9" />
        <path d="M8 16 Q13 13 18 14.5 L18 17.5 Q13 19 8 16 Z" fill="#ffe066" />
        <path d="M18 9 L56 9 Q68 12 70 16 Q68 20 56 23 L18 23 Z" fill="#eef2f7" />
        <path d="M56 9 Q68 12 70 16 Q68 20 56 23 Q60 16 56 9 Z" fill="#e5484d" />
        <path d="M22 9 L14 2 L30 9 Z M22 23 L14 30 L30 23 Z" fill="#e5484d" />
        <circle cx="44" cy="16" r="4.6" fill="#2b5fae" stroke="#9fb4cf" strokeWidth="1.6" />
        <circle cx="42.6" cy="14.6" r="1.3" fill="#cfe1ff" />
      </>
    ),
  },
  egg1: {
    vb: [32, 32],
    draw: () => (
      <>
        <path d={EGG} fill="#d8433b" />
        <path d="M5 17 Q16 13 27 17 L27.6 20.5 Q16 16.5 4.4 20.5 Z" fill="#ffd36a" />
        <circle cx="11" cy="25" r="1.6" fill="#fff3d6" />
        <circle cx="16" cy="26" r="1.6" fill="#fff3d6" />
        <circle cx="21" cy="25" r="1.6" fill="#fff3d6" />
        <path d="M12 7 L16 11 L20 7" stroke="#fff3d6" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      </>
    ),
  },
  egg2: {
    vb: [32, 32],
    draw: () => (
      <>
        <path d={EGG} fill="#3c7bd4" />
        <path d="M6.5 12 Q16 9 25.5 12 M4.5 22 Q16 19 27.5 22" stroke="#fff" strokeWidth="2" fill="none" />
        <path d="M10 17 L13 14.5 L16 17 L19 14.5 L22 17" stroke="#ffd36a" strokeWidth="1.8" fill="none" strokeLinejoin="round" />
      </>
    ),
  },
  egg3: {
    vb: [32, 32],
    draw: () => (
      <>
        <path d={EGG} fill="#f3c33c" />
        <circle cx="16" cy="19" r="5" fill="#e0573e" />
        <circle cx="16" cy="19" r="2.2" fill="#fff6df" />
        <path d="M9 10 Q16 6 23 10" stroke="#5b9a3d" strokeWidth="2" fill="none" strokeLinecap="round" />
      </>
    ),
  },
  confetti1: { vb: [16, 10], draw: () => <rect x="1" y="1" width="14" height="8" rx="2" fill="#ffffff" /> },
  confetti2: { vb: [16, 10], draw: () => <rect x="1" y="1" width="14" height="8" rx="2" fill="#2f63d6" /> },
  confetti3: { vb: [16, 10], draw: () => <rect x="1" y="1" width="14" height="8" rx="2" fill="#d8392b" /> },
  leaf1: { vb: [32, 32], draw: () => <path d={MAPLE} fill="#e8692c" /> },
  leaf2: { vb: [32, 32], draw: () => <path d={MAPLE} fill="#d23d22" /> },
  leaf3: { vb: [32, 32], draw: () => <path d={MAPLE} fill="#efa52a" /> },
  bat: {
    vb: [48, 24],
    draw: () => (
      <path
        d="M24 9 L22.4 5.6 L21.6 8.6 Q17 4 9 4 Q12 7 11 10 Q6 9 1 12 Q6 13 8 17 Q12 14 16 16 Q19 14 22 18 L24 21 L26 18 Q29 14 32 16 Q36 14 40 17 Q42 13 47 12 Q42 9 37 10 Q36 7 39 4 Q31 4 26.4 8.6 L25.6 5.6 Z"
        fill="#2c1f3f"
        stroke="#a98bdc"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    ),
  },
};

/** One sprite at width `s` (height from its viewBox). */
export function SeasonSprite({ id, s, rot = 0 }: { id: SpriteId; s: number; rot?: number }) {
  const sp = SPRITES[id];
  const h = Math.round((s * sp.vb[1]) / sp.vb[0]);
  return (
    <svg width={s} height={h} viewBox={`0 0 ${sp.vb[0]} ${sp.vb[1]}`} style={rot ? { transform: `rotate(${rot}deg)` } : undefined} aria-hidden focusable="false">
      {sp.draw()}
    </svg>
  );
}

// ---------------------------------------------------------------- static accents

/** Мascot hats: drawn inside the mascot's 120×120 viewBox, over the antennae. */
export function MascotHat({ hat }: { hat: "santa" | "witch" }) {
  if (hat === "santa")
    return (
      <g data-hat="santa">
        <path d="M14 34 Q20 6 52 2 Q78 0 92 22 L84 28 Q72 14 60 16 Q74 26 70 34 Z" fill="#d72b32" />
        <path d="M60 16 Q74 26 70 34 L64 34 Q66 24 56 17 Z" fill="#a91d24" />
        <rect x="10" y="27" width="66" height="13" rx="6.5" fill="#f5f5f2" />
        <circle cx="92" cy="24" r="8.5" fill="#f5f5f2" />
      </g>
    );
  return (
    <g data-hat="witch">
      <ellipse cx="60" cy="31" rx="50" ry="7.5" fill="#2a1b40" stroke="#8f6cd6" strokeWidth="1.5" />
      <path d="M32 30 Q44 18 50 6 Q58 -2 78 4 Q66 6 66 16 L84 30 Z" fill="#2a1b40" stroke="#8f6cd6" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M36 25.5 L80 25.5 L83 29 L33 29 Z" fill="#ff8a1f" />
      <rect x="54" y="23" width="9" height="8" rx="1.5" fill="none" stroke="#ffd36a" strokeWidth="2" />
    </g>
  );
}

/** «Верба»: a pussy-willow branch for the top corners at Easter (static). */
export function WillowBranch({ width }: { width: number }) {
  const buds: [number, number, number][] = [
    [40, 40, -30],
    [70, 52, -20],
    [100, 60, -10],
    [128, 66, 0],
    [156, 68, 10],
    [56, 30, -60],
    [86, 41, -40],
    [118, 50, -30],
    [182, 66, 20],
    [206, 60, 30],
  ];
  return (
    <svg width={width} height={Math.round((width * 120) / 240)} viewBox="0 0 240 120" aria-hidden focusable="false">
      <path d="M0 18 Q60 30 120 62 Q170 76 236 58" stroke="#6b4a32" strokeWidth="3.4" fill="none" strokeLinecap="round" />
      <path d="M58 40 Q72 22 90 14 M150 72 Q170 92 196 100" stroke="#6b4a32" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      {buds.map(([x, y, r], i) => (
        <g key={i} transform={`translate(${x} ${y}) rotate(${r})`}>
          <ellipse cx="0" cy="-8" rx="5.6" ry="9" fill="#e9e6df" />
          <ellipse cx="-1.4" cy="-10" rx="2.6" ry="4.4" fill="#ffffff" opacity=".8" />
          <path d="M-4 -1 Q0 3 4 -1" stroke="#7e5a3a" strokeWidth="2" fill="none" />
        </g>
      ))}
      {[
        [80, 18],
        [192, 100],
      ].map(([x, y], i) => (
        <g key={`t${i}`} transform={`translate(${x} ${y}) rotate(${i ? 70 : -50})`}>
          <ellipse cx="0" cy="-8" rx="5" ry="8" fill="#e9e6df" />
        </g>
      ))}
    </svg>
  );
}

/** Two jack-o'-lanterns for the bottom corner at Halloween (static, friendly faces). */
export function Pumpkins({ width }: { width: number }) {
  const pumpkin = (x: number, y: number, s: number, key: string) => (
    <g key={key} transform={`translate(${x} ${y}) scale(${s})`}>
      <path d="M0 -30 Q2 -40 8 -42" stroke="#4f7a2c" strokeWidth="5" fill="none" strokeLinecap="round" />
      <ellipse cx="-14" cy="0" rx="18" ry="26" fill="#e8741c" />
      <ellipse cx="14" cy="0" rx="18" ry="26" fill="#e8741c" />
      <ellipse cx="0" cy="0" rx="16" ry="28" fill="#f58a2a" />
      <path d="M-14 -6 L-8 -14 L-3 -6 Z M14 -6 L8 -14 L3 -6 Z" fill="#5a2a08" />
      <path d="M-15 6 Q0 20 15 6 L10 9 L6 6 L2 10 L-2 6 L-6 10 L-10 6 Z" fill="#5a2a08" />
    </g>
  );
  return (
    <svg width={width} height={Math.round((width * 80) / 130)} viewBox="0 0 130 80" aria-hidden focusable="false">
      {pumpkin(40, 50, 0.95, "a")}
      {pumpkin(98, 58, 0.7, "b")}
    </svg>
  );
}

/** Георгиевская лента as a small awareness loop: three stacked strokes give its five black–orange stripes. */
export function RibbonLoop({ size }: { size: number }) {
  const d = "M7 30 L15.4 14 Q19 7 16.6 4.2 Q14 1.6 11.4 4.2 Q9 7 12.6 14 L21 30";
  return (
    <svg width={Math.round((size * 28) / 32)} height={size} viewBox="0 0 28 32" aria-hidden focusable="false">
      {[
        ["#141414", 7.5],
        ["#e8811a", 4.5],
        ["#141414", 1.5],
      ].map(([c, w]) => (
        <path key={String(w)} d={d} stroke={c as string} strokeWidth={w as number} fill="none" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

import { useState } from "react";

/**
 * «Попкорн» loader (owner's mascot set, variant 04, made into a real progress
 * indicator): a popcorn bucket with a face whose heap of kernels grows with
 * `progress` (0..1). While loading, kernels keep popping out in arcs; at 100%
 * the bucket does a happy hop. Only transform/opacity are animated (cheap on
 * old TV engines); geometry uses SVG attributes only.
 */

// Heap kernels in the order they appear (bottom-up, centre-out).
const HEAP: { cx: number; cy: number; r: number }[] = [
  { cx: 84, cy: 88, r: 17 },
  { cx: 116, cy: 88, r: 17 },
  { cx: 62, cy: 86, r: 15 },
  { cx: 140, cy: 86, r: 15 },
  { cx: 100, cy: 80, r: 19 },
  { cx: 72, cy: 72, r: 17 },
  { cx: 128, cy: 72, r: 17 },
  { cx: 52, cy: 76, r: 13 },
  { cx: 150, cy: 76, r: 13 },
  { cx: 96, cy: 62, r: 20 },
  { cx: 120, cy: 56, r: 17 },
  { cx: 78, cy: 54, r: 16 },
  { cx: 104, cy: 42, r: 15 },
  { cx: 88, cy: 34, r: 11 },
];

const KERNEL = "#FFF1C9";
const KERNEL_SHADE = "#F3D98E";
const LIME = "rgb(var(--mt-accent, 200, 255, 61))";
const INK = "#06080C";
const CHEEK = "#FF8FB1";

const CSS = `
@keyframes mtpWobble{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}
@keyframes mtpHop{0%,100%{transform:translateY(0) scale(1.06,.94)}25%{transform:translateY(-6px) scale(.96,1.05)}50%{transform:translateY(-22px) scale(1,1)}80%{transform:translateY(-2px) scale(1.02,.98)}}
@keyframes mtpBlink{0%,88%,100%{transform:scaleY(1)}92%{transform:scaleY(.1)}}
@keyframes mtpPopA{0%,15%{transform:translate(0,0) rotate(0);opacity:0}22%{opacity:1}50%{transform:translate(-34px,-78px) rotate(-200deg);opacity:1}80%,100%{transform:translate(-56px,-10px) rotate(-360deg);opacity:0}}
@keyframes mtpPopB{0%,40%{transform:translate(0,0) rotate(0);opacity:0}47%{opacity:1}72%{transform:translate(30px,-86px) rotate(210deg);opacity:1}100%{transform:translate(58px,-16px) rotate(380deg);opacity:0}}
@keyframes mtpPopC{0%,65%{transform:translate(0,0) rotate(0);opacity:0}70%{opacity:1}88%{transform:translate(6px,-70px) rotate(160deg);opacity:1}100%{transform:translate(12px,-40px) rotate(260deg);opacity:0}}
@keyframes mtpIn{0%{transform:scale(0)}70%{transform:scale(1.18)}100%{transform:scale(1)}}
@keyframes mtpTwinkle{0%,100%{transform:scale(.45) rotate(0);opacity:.3}50%{transform:scale(1.1) rotate(45deg);opacity:1}}
@keyframes mtpShadow{0%,100%{transform:scaleX(1);opacity:.35}50%{transform:scaleX(.8);opacity:.2}}
`;

function Kernel({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  // A puffy kernel: three overlapping lobes plus a little shade.
  return (
    <>
      <circle cx={cx} cy={cy} r={r} fill={KERNEL} />
      <circle cx={cx - r * 0.55} cy={cy + r * 0.15} r={r * 0.62} fill={KERNEL} />
      <circle cx={cx + r * 0.5} cy={cy - r * 0.25} r={r * 0.58} fill={KERNEL} />
      <circle cx={cx + r * 0.25} cy={cy + r * 0.45} r={r * 0.28} fill={KERNEL_SHADE} opacity={0.7} />
    </>
  );
}

export function PopcornLoader({
  progress,
  size = 260,
  className = "",
  label,
}: {
  /** 0..1; never goes backwards visually. */
  progress: number;
  size?: number;
  className?: string;
  /** Accessible label, e.g. "Готовим поток, 42%". */
  label?: string;
}) {
  // Monotonic: a kernel that appeared stays (state adjusted during render,
  // the React-recommended way to derive "max so far").
  const clamped = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const target = Math.floor(clamped * HEAP.length + 1e-9);
  const [count, setCount] = useState(target);
  if (target > count) setCount(target);
  const done = clamped >= 1;

  const t = (s: string): React.CSSProperties => ({ transformBox: "view-box" as const, transformOrigin: s });

  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      overflow="visible"
      role="img"
      aria-label={label}
      className={className}
    >
      <style>{CSS}</style>
      {/* ground shadow */}
      <ellipse cx="100" cy="190" rx="52" ry="7" fill="#000" style={{ ...t("100px 190px"), animation: "mtpShadow 1.2s ease-in-out infinite" }} />

      <g style={{ ...t("100px 182px"), animation: done ? "mtpHop .9s ease-in-out infinite" : "mtpWobble 1.2s ease-in-out infinite" }}>
        {/* kernels popping out while loading (behind the heap) */}
        {!done && (
          <>
            <g style={{ ...t("100px 86px"), animation: "mtpPopA 2.4s ease-in-out infinite" }}>
              <Kernel cx={100} cy={86} r={9} />
            </g>
            <g style={{ ...t("110px 86px"), animation: "mtpPopB 2.4s ease-in-out infinite" }}>
              <Kernel cx={110} cy={86} r={8} />
            </g>
            <g style={{ ...t("92px 86px"), animation: "mtpPopC 2.4s ease-in-out infinite" }}>
              <Kernel cx={92} cy={86} r={7} />
            </g>
          </>
        )}

        {/* the heap: one kernel per 1/14 of progress */}
        {HEAP.slice(0, count).map((k, i) => (
          <g key={i} style={{ ...t(`${k.cx}px ${k.cy}px`), animation: "mtpIn .45s cubic-bezier(.3,1.6,.5,1) both" }}>
            <Kernel {...k} />
          </g>
        ))}

        {/* bucket */}
        <path d="M44 94 L156 94 L142 180 L58 180 Z" fill="#F2F4F7" stroke="#F2F4F7" strokeWidth="6" strokeLinejoin="round" />
        <path d="M60 94 L76 94 L80 180 L68 180 Z" fill={LIME} />
        <path d="M92 94 L108 94 L106 180 L94 180 Z" fill={LIME} />
        <path d="M124 94 L140 94 L132 180 L120 180 Z" fill={LIME} />
        <rect x="38" y="88" width="124" height="14" rx="7" fill={LIME} />

        {/* face */}
        <g style={{ ...t("100px 128px"), animation: "mtpBlink 2.4s linear -1.2s infinite" }}>
          {done ? (
            <>
              <path d="M78 130 Q84 121 90 130" stroke={INK} strokeWidth="5" strokeLinecap="round" fill="none" />
              <path d="M110 130 Q116 121 122 130" stroke={INK} strokeWidth="5" strokeLinecap="round" fill="none" />
            </>
          ) : (
            <>
              <ellipse cx="84" cy="128" rx="6" ry="8" fill={INK} />
              <ellipse cx="116" cy="128" rx="6" ry="8" fill={INK} />
              <circle cx="86" cy="125" r="2" fill="#fff" />
              <circle cx="118" cy="125" r="2" fill="#fff" />
            </>
          )}
        </g>
        <path
          d={done ? "M86 144 Q100 162 114 144" : "M90 146 Q100 156 110 146"}
          stroke={INK}
          strokeWidth="5"
          strokeLinecap="round"
          fill={done ? INK : "none"}
        />
        <circle cx="72" cy="142" r="6" fill={CHEEK} />
        <circle cx="128" cy="142" r="6" fill={CHEEK} />
      </g>

      {/* sparkles */}
      <path
        d="M172 40 Q174 51 185 53 Q174 55 172 66 Q170 55 159 53 Q170 51 172 40 Z"
        fill={LIME}
        style={{ ...t("172px 53px"), animation: "mtpTwinkle 1.2s ease-in-out infinite" }}
      />
      <path
        d="M28 120 Q29 126 35 127 Q29 128 28 134 Q27 128 21 127 Q27 126 28 120 Z"
        fill={LIME}
        style={{ ...t("28px 127px"), animation: "mtpTwinkle 1.2s ease-in-out -.6s infinite" }}
      />
    </svg>
  );
}

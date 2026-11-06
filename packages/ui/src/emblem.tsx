// «Конструктивизм»'s emblem: a hammer and sickle drawn as plain SVG strokes
// (no images), on a red disc by default: the player loaders, the intro, the
// favicon and the «Ленин в Октябре» card. (The mascot there is Mayakovsky.)
import type { CSSProperties } from "react";

export const CV_RED = "#d7261e";
export const CV_PAPER = "#efe4cc";
export const CV_INK = "#1a1512";

// viewBox 0 0 100 100. The sickle: a 285° arc (lower-left → bottom → right →
// top → tip at the upper-left) plus its handle; the hammer crosses it from
// the lower right, its head at the upper left.
const SICKLE = "M32.9 66.1 A27 27 0 1 0 28.6 33.5";
const SICKLE_TIP = "M28.6 33.5 L21 27 L34.5 29.5 Z";
const SICKLE_HANDLE = "M32.9 66.1 L19 80";
const HAMMER_HANDLE = "M78 84 L39 45";

function shapes(fg: string): string {
  return (
    `<path d="${SICKLE}" fill="none" stroke="${fg}" stroke-width="8"/>` +
    `<path d="${SICKLE_TIP}" fill="${fg}"/>` +
    `<path d="${SICKLE_HANDLE}" stroke="${fg}" stroke-width="9.5" stroke-linecap="round"/>` +
    `<path d="${HAMMER_HANDLE}" stroke="${fg}" stroke-width="8" stroke-linecap="round"/>` +
    `<rect x="-16" y="-6.5" width="32" height="13" fill="${fg}" transform="translate(36.5 42.5) rotate(-45)"/>`
  );
}

/** The tab icon in «Конструктивизм» (an SVG data URI). */
export const EMBLEM_FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="${CV_RED}"/><g transform="translate(9 8) scale(.82)">${shapes(CV_PAPER)}</g></svg>`);

/**
 * Hammer and sickle. `bg` = the disc behind it (null = none, the symbol
 * alone in `color`). Sized by `size` or, with size 0, by `className`.
 */
export function SovietEmblem({
  size = 40,
  color = CV_PAPER,
  bg = CV_RED,
  className = "",
  style,
}: {
  size?: number;
  color?: string;
  bg?: string | null;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size || undefined}
      height={size || undefined}
      className={className}
      style={style}
      data-emblem="hammer-sickle"
      aria-hidden
      focusable="false"
    >
      {bg && <circle cx="50" cy="50" r="50" fill={bg} />}
      <g transform={bg ? "translate(9 8) scale(.82)" : undefined}>
        <path d={SICKLE} fill="none" stroke={color} strokeWidth="8" />
        <path d={SICKLE_TIP} fill={color} />
        <path d={SICKLE_HANDLE} stroke={color} strokeWidth="9.5" strokeLinecap="round" />
        <path d={HAMMER_HANDLE} stroke={color} strokeWidth="8" strokeLinecap="round" />
        <rect x="-16" y="-6.5" width="32" height="13" fill={color} transform="translate(36.5 42.5) rotate(-45)" />
      </g>
    </svg>
  );
}

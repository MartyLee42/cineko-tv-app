// Line icons (24×24 grid, stroked with currentColor). «Конструктивизм» draws
// its filled pictograms instead (`cv`, @martytv/ui cvIcons).
import { CvIcon, useConstructivism, type CvGlyph } from "@martytv/ui";

const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" } as const;

function Svg({ size = 34, stroke = 1.8, cv, children }: { size?: number; stroke?: number; cv?: CvGlyph; children: React.ReactNode }) {
  const on = useConstructivism();
  if (on && cv) return <CvIcon glyph={cv} width={size} height={size} />;
  return (
    <svg {...base} width={size} height={size} strokeWidth={stroke} aria-hidden>
      {children}
    </svg>
  );
}

type P = { size?: number; stroke?: number };

export const CompassIcon = (p: P) => (
  <Svg {...p} cv="compass">
    <circle cx="12" cy="12" r="8.5" />
    <path d="m15.5 8.5-2 5-5 2 2-5z" />
  </Svg>
);
export const DiceIcon = (p: P) => (
  <Svg {...p} cv="dice">
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <circle cx="8.5" cy="8.5" r="1" fill="currentColor" />
    <circle cx="15.5" cy="8.5" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="8.5" cy="15.5" r="1" fill="currentColor" />
    <circle cx="15.5" cy="15.5" r="1" fill="currentColor" />
  </Svg>
);
/** «Спросить ИИ»: a speech bubble with a spark. */
export const SparkIcon = (p: P) => (
  <Svg {...p} cv="spark">
    <path d="M20 12.5a7.5 7.5 0 0 1-11.2 6.5L4 20l1.1-4.3A7.5 7.5 0 1 1 20 12.5z" />
    <path d="M12.5 8.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill="currentColor" />
  </Svg>
);
export const ClockIcon = (p: P) => (
  <Svg {...p} cv="clock">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);
export const HomeIcon = (p: P) => (
  <Svg {...p} cv="home">
    <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z" />
  </Svg>
);
export const SearchIcon = (p: P) => (
  <Svg {...p} cv="search">
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Svg>
);
export const FilmIcon = (p: P) => (
  <Svg {...p} cv="film">
    <rect x="4" y="3.5" width="16" height="17" rx="2" />
    <path d="M8 3.5v17M16 3.5v17M4 8.5h4M4 12h4M4 15.5h4M16 8.5h4M16 12h4M16 15.5h4" />
  </Svg>
);
export const TvIcon = (p: P) => (
  <Svg {...p} cv="tv">
    <rect x="3.5" y="6" width="17" height="12" rx="2" />
    <path d="M9 21h6M8.5 2.5 12 6l3.5-3.5" />
  </Svg>
);
/** «Новые серии»: a TV screen with a four-point spark. */
export const NewEpisodesIcon = (p: P) => (
  <Svg {...p} cv="newEpisodes">
    <rect x="3" y="6.5" width="15" height="11.5" rx="2" />
    <path d="M8 21h5" />
    <path d="M19 2.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
  </Svg>
);
export const BookmarkIcon = (p: P & { filled?: boolean }) => (
  <Svg size={p.size} stroke={p.stroke} cv={p.filled ? "bookmark" : "bookmarkOutline"}>
    <path d="M6.5 3.5h11v17L12 16.5l-5.5 4z" fill={p.filled ? "currentColor" : "none"} />
  </Svg>
);
export const MessageIcon = (p: P) => (
  <Svg {...p} cv="message">
    <path d="M4 5h16v11H9l-5 4z" />
  </Svg>
);
export const SlidersIcon = (p: P) => (
  <Svg {...p} cv="sliders">
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Svg>
);
export const ListIcon = (p: P) => (
  <Svg {...p} cv="list">
    <path d="M5 7h14M5 12h14M5 17h9" />
  </Svg>
);
export const TrailerIcon = (p: P) => (
  <Svg {...p} cv="trailer">
    <rect x="3.5" y="5" width="17" height="14" rx="3" />
    <path d="m10.5 9.5 4 2.5-4 2.5z" fill="currentColor" />
  </Svg>
);
export const MoreIcon = (p: P) => (
  <Svg {...p} cv="more">
    <circle cx="6" cy="12" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="18" cy="12" r="1" fill="currentColor" />
  </Svg>
);
export const BackIcon = (p: P) => (
  <Svg {...p} cv="back">
    <path d="M9 14 4.5 9.5 9 5" />
    <path d="M4.5 9.5H15a4.5 4.5 0 0 1 0 9h-3" />
  </Svg>
);
export const PlusIcon = (p: P) => (
  <Svg {...p} cv="plus">
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const CheckIcon = (p: P) => (
  <Svg {...p} cv="check">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);
export const PlayGlyph = ({ size = 22 }: { size?: number }) =>
  useConstructivism() ? (
    <CvIcon glyph="play" width={size} height={size} />
  ) : (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
    <path d="M7 4.5v15l13-7.5z" fill="currentColor" />
  </svg>
);
/** «ТВ» (live channels): a screen with an antenna. */
export const LiveTvIcon = (p: P) => (
  <Svg {...p} cv="liveTv">
    <rect x="3.5" y="7.5" width="17" height="12" rx="2" />
    <path d="m8.5 3.5 3.5 4 3.5-4" />
  </Svg>
);
/** «Видео»: a rounded screen with a play triangle. */
export const PlayTileIcon = (p: P) => (
  <Svg {...p} cv="playTile">
    <rect x="2.5" y="5" width="19" height="14" rx="4" />
    <path d="m10 9.2 5 2.8-5 2.8z" />
  </Svg>
);

// Small inline stroke icons (24×24 viewBox, currentColor). «Конструктивизм»
// draws its filled pictograms instead (`cv`, @martytv/ui cvIcons).
import type { SVGProps } from "react";
import { CvIcon, useConstructivism, type CvGlyph } from "@martytv/ui";

function Svg({ children, cv, ...rest }: SVGProps<SVGSVGElement> & { cv?: CvGlyph }) {
  const on = useConstructivism();
  if (on && cv) return <CvIcon glyph={cv} {...rest} />;
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

type P = SVGProps<SVGSVGElement>;

export const HomeIcon = (p: P) => (
  <Svg {...p} cv="home">
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V21h14V9.5" />
  </Svg>
);
export const GridIcon = (p: P) => (
  <Svg {...p} cv="grid">
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </Svg>
);
export const SearchIcon = (p: P) => (
  <Svg {...p} cv="search">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Svg>
);
export const TvIcon = (p: P) => (
  <Svg {...p} cv="tv">
    <rect x="2" y="5" width="20" height="13" rx="2" />
    <path d="M8 21h8" />
  </Svg>
);
export const UserIcon = (p: P) => (
  <Svg {...p} cv="user">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
  </Svg>
);
export const ShieldIcon = (p: P) => (
  <Svg {...p} cv="shield">
    <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />
  </Svg>
);
export const ChevronLeft = (p: P) => (
  <Svg {...p} cv="chevronLeft">
    <path d="m15 18-6-6 6-6" />
  </Svg>
);
export const ChevronRight = (p: P) => (
  <Svg {...p} cv="chevronRight">
    <path d="m9 18 6-6-6-6" />
  </Svg>
);
export const PlayIcon = (p: P) => (
  <Svg {...p} cv="play" fill="currentColor" stroke="none">
    <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
  </Svg>
);
export const StarIcon = (p: P) => (
  <Svg {...p} cv="star" fill="currentColor" stroke="none">
    <path d="m12 2.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3L2.9 9.5l6.3-.9z" />
  </Svg>
);
export const FilterIcon = (p: P) => (
  <Svg {...p} cv="filter">
    <path d="M4 6h16M7 12h10M10 18h4" />
  </Svg>
);
export const CloseIcon = (p: P) => (
  <Svg {...p} cv="close">
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
/** TV with an incoming arrow: "send to TV". */
export const CastIcon = (p: P) => (
  <Svg {...p} cv="cast">
    <path d="M2 8V7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-6" />
    <path d="M2 12a7 7 0 0 1 7 7" />
    <path d="M2 16a3 3 0 0 1 3 3" />
    <path d="M2 19.5h.01" strokeWidth={3} />
  </Svg>
);
export const RemoteIcon = (p: P) => (
  <Svg {...p} cv="remote">
    <rect x="7" y="2" width="10" height="20" rx="3" />
    <circle cx="12" cy="8" r="2" />
    <path d="M10 14h.01M14 14h.01M10 17.5h.01M14 17.5h.01" strokeWidth={2.6} />
  </Svg>
);
export const CheckIcon = (p: P) => (
  <Svg {...p} cv="check">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);
export const AlertIcon = (p: P) => (
  <Svg {...p} cv="alert">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5M12 16.5h.01" />
  </Svg>
);
export const PauseIcon = (p: P) => (
  <Svg {...p} cv="pause" fill="currentColor" stroke="none">
    <rect x="6" y="4.5" width="4" height="15" rx="1.2" />
    <rect x="14" y="4.5" width="4" height="15" rx="1.2" />
  </Svg>
);
export const BackIcon = (p: P) => (
  <Svg {...p} cv="rewind">
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 3v5h5" />
  </Svg>
);
export const ForwardIcon = (p: P) => (
  <Svg {...p} cv="forward">
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <path d="M21 3v5h-5" />
  </Svg>
);
export const NextIcon = (p: P) => (
  <Svg {...p} cv="next">
    <path d="m5 5 10 7-10 7z" fill="currentColor" />
    <path d="M19 5v14" />
  </Svg>
);
export const VolumeIcon = (p: P) => (
  <Svg {...p} cv="volume">
    <path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z" />
    <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" />
  </Svg>
);
/** Stacked lines: "choose a release". */
export const ListIcon = (p: P) => (
  <Svg {...p} cv="list">
    <path d="M8 6h13M8 12h13M8 18h13" />
    <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" strokeWidth={2.8} />
  </Svg>
);
export const RefreshIcon = (p: P) => (
  <Svg {...p} cv="refresh">
    <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
    <path d="M4 3v5h5" />
    <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
    <path d="M20 21v-5h-5" />
  </Svg>
);
export const ArrowUpIcon = (p: P) => (
  <Svg {...p} cv="arrowUp">
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
);
export const ArrowDownIcon = (p: P) => (
  <Svg {...p} cv="arrowDown">
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Svg>
);
/** A phone: "on this device". */
export const DeviceIcon = (p: P) => (
  <Svg {...p} cv="device">
    <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
  </Svg>
);
export const CopyIcon = (p: P) => (
  <Svg {...p} cv="copy">
    <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
    <path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
  </Svg>
);
export const DownloadIcon = (p: P) => (
  <Svg {...p} cv="download">
    <path d="M12 4v11M7 10.5l5 5 5-5" />
    <path d="M4.5 19.5h15" />
  </Svg>
);
export const HeartIcon = ({ filled, ...p }: P & { filled?: boolean }) => (
  <Svg {...p} cv={filled ? "heart" : "heartOutline"} fill={filled ? "currentColor" : "none"}>
    <path d="M12 20.5s-7.5-4.6-9.2-9.4C1.7 7.8 3.9 4.5 7.3 4.5c2 0 3.5 1.1 4.7 2.8 1.2-1.7 2.7-2.8 4.7-2.8 3.4 0 5.6 3.3 4.5 6.6-1.7 4.8-9.2 9.4-9.2 9.4z" />
  </Svg>
);
export const BookmarkIcon = ({ filled, ...p }: P & { filled?: boolean }) => (
  <Svg {...p} cv={filled ? "bookmark" : "bookmarkOutline"} fill={filled ? "currentColor" : "none"}>
    <path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4.5L5 21V4.5a1 1 0 0 1 1-1z" />
  </Svg>
);
export const BellIcon = (p: P) => (
  <Svg {...p} cv="bell">
    <path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z" />
    <path d="M10 20a2.2 2.2 0 0 0 4 0" />
  </Svg>
);
export const GearIcon = (p: P) => (
  <Svg {...p} cv="gear">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Svg>
);
export const HistoryIcon = (p: P) => (
  <Svg {...p} cv="history">
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l3 2" />
  </Svg>
);
export const EyeIcon = ({ off, ...p }: P & { off?: boolean }) => (
  <Svg {...p} cv={off ? "eyeOff" : "eye"}>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
    {off && <path d="M3 3l18 18" />}
  </Svg>
);
export const RestartIcon = (p: P) => (
  <Svg {...p} cv="restart">
    <path d="M4 12a8 8 0 1 0 2.3-5.6" />
    <path d="M4 4v4.5h4.5" />
  </Svg>
);
export const MuteIcon = (p: P) => (
  <Svg {...p} cv="mute">
    <path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z" />
    <path d="m16 9.5 5 5M21 9.5l-5 5" />
  </Svg>
);
export const FullscreenIcon = (p: P) => (
  <Svg {...p} cv="fullscreen">
    <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
  </Svg>
);
export const ExitFullscreenIcon = (p: P) => (
  <Svg {...p} cv="exitFullscreen">
    <path d="M9 4v3.5A1.5 1.5 0 0 1 7.5 9H4M20 9h-3.5A1.5 1.5 0 0 1 15 7.5V4M15 20v-3.5a1.5 1.5 0 0 1 1.5-1.5H20M4 15h3.5A1.5 1.5 0 0 1 9 16.5V20" />
  </Svg>
);
export const PipIcon = (p: P) => (
  <Svg {...p} cv="pip">
    <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
    <rect x="12" y="11.5" width="7" height="5.5" rx="1" fill="currentColor" stroke="none" />
  </Svg>
);
export const SubtitlesIcon = (p: P) => (
  <Svg {...p} cv="subtitles">
    <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
    <path d="M6.5 12.5h3M12 12.5h5.5M6.5 15.5h6M14.5 15.5h3" />
  </Svg>
);
export const AudioTrackIcon = (p: P) => (
  <Svg {...p} cv="audio">
    <path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10" />
  </Svg>
);
export const SpeedIcon = (p: P) => (
  <Svg {...p} cv="speed">
    <path d="M4.5 18.5a9 9 0 1 1 15 0" />
    <path d="m12 13.5 4-5" />
    <circle cx="12" cy="13.5" r="1.3" fill="currentColor" />
  </Svg>
);
/** Circular arrow with the seconds inside: −10 / +30. */
export const SkipIcon = ({ seconds, ...p }: P & { seconds: number }) =>
  useConstructivism() ? (
    // A thick ring with a red arrowhead (mirrored for +), the seconds in the middle.
    <CvIcon glyph="restart" mirror={seconds > 0} {...p}>
      <text x="12" y="15.6" textAnchor="middle" fontSize="9" fontWeight="700" fill="currentColor" fontFamily="Oswald, system-ui, sans-serif">
        {Math.abs(seconds)}
      </text>
    </CvIcon>
  ) : (
  <Svg {...p}>
    {seconds < 0 ? (
      <>
        <path d="M4 12a8 8 0 1 0 2.3-5.6" />
        <path d="M4 3.5v4.5h4.5" />
      </>
    ) : (
      <>
        <path d="M20 12a8 8 0 1 1-2.3-5.6" />
        <path d="M20 3.5v4.5h-4.5" />
      </>
    )}
    <text x="12" y="15.6" textAnchor="middle" fontSize="8.5" fontWeight="700" fill="currentColor" stroke="none" fontFamily="system-ui, sans-serif">
      {Math.abs(seconds)}
    </text>
  </Svg>
);

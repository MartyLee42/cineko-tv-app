import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const PlayIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11.04-6.86a1 1 0 0 0 0-1.72L9.5 4.28A1 1 0 0 0 8 5.14z" />
  </Svg>
);
export const PauseIcon = (p: P) => (
  <Svg {...p}>
    <rect x="6" y="4.5" width="4" height="15" rx="1.2" />
    <rect x="14" y="4.5" width="4" height="15" rx="1.2" />
  </Svg>
);
export const NextIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 6.2v11.6a.8.8 0 0 0 1.24.66L15 12.66a.8.8 0 0 0 0-1.32L6.24 5.54A.8.8 0 0 0 5 6.2z" />
    <rect x="16.5" y="5" width="2.6" height="14" rx="1" />
  </Svg>
);
export const PrevIcon = (p: P) => (
  <Svg {...p}>
    <path d="M19 6.2v11.6a.8.8 0 0 1-1.24.66L9 12.66a.8.8 0 0 1 0-1.32l8.76-5.8A.8.8 0 0 1 19 6.2z" />
    <rect x="4.9" y="5" width="2.6" height="14" rx="1" />
  </Svg>
);
export const ShuffleIcon = (p: P) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
  </Svg>
);
export const RepeatIcon = ({ one, ...p }: P & { one?: boolean }) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 2l4 4-4 4" />
    <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
    <path d="M7 22l-4-4 4-4" />
    <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    {one && <text x="12" y="14.6" fontSize="8" textAnchor="middle" fill="currentColor" stroke="none" fontWeight="700">1</text>}
  </Svg>
);
export const HeartIcon = ({ filled, ...p }: P & { filled?: boolean }) => (
  <Svg {...p} fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2} strokeLinejoin="round">
    <path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 7.9 3.6 4.5 7.1 4.5c2 0 3.5 1.1 4.9 2.9 1.4-1.8 2.9-2.9 4.9-2.9 3.5 0 5.7 3.4 4.4 6.8-1.8 4.6-9.3 9.2-9.3 9.2z" />
  </Svg>
);
export const MoreIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="2" />
    <circle cx="12" cy="12" r="2" />
    <circle cx="19" cy="12" r="2" />
  </Svg>
);
export const VolumeIcon = ({ level = 1, ...p }: P & { level?: number }) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" />
    {level > 0 && <path d="M15.5 8.5a5 5 0 0 1 0 7" />}
    {level > 0.5 && <path d="M18.5 5.5a9 9 0 0 1 0 13" />}
    {level === 0 && <path d="M16 9l5 6M21 9l-5 6" />}
  </Svg>
);
export const QueueIcon = (p: P) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
    <path d="M3 6h13M3 12h13M3 18h8" />
    <path d="M17 15v6l4-3z" fill="currentColor" />
  </Svg>
);
export const LyricsIcon = (p: P) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 5h16v11H9l-5 4z" />
    <path d="M8 9h8M8 12h5" />
  </Svg>
);
export const HomeIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.2 2.8 10.4a1 1 0 0 0 .62 1.8H5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-7.8h1.58a1 1 0 0 0 .62-1.8z" />
  </Svg>
);
export const SearchIcon = (p: P) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.5 15.5 5 5" />
  </Svg>
);
export const LibraryIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="3.2" height="18" rx="1" />
    <rect x="8.4" y="3" width="3.2" height="18" rx="1" />
    <path d="M14.2 4.4 17.3 3.6a1 1 0 0 1 1.2.7l3.6 14.5a1 1 0 0 1-.7 1.2l-3.1.8a1 1 0 0 1-1.2-.7L13.5 5.6a1 1 0 0 1 .7-1.2z" />
  </Svg>
);
export const PlusIcon = (p: P) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const CloseIcon = (p: P) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const ChevronDownIcon = (p: P) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 9 6 6 6-6" />
  </Svg>
);
export const BackIcon = (p: P) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
    <path d="m15 5-7 7 7 7" />
  </Svg>
);
export const WaveIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="10" width="2.6" height="4" rx="1.3" />
    <rect x="7.4" y="6" width="2.6" height="12" rx="1.3" />
    <rect x="11.8" y="3" width="2.6" height="18" rx="1.3" />
    <rect x="16.2" y="7.5" width="2.6" height="9" rx="1.3" />
    <rect x="20.4" y="10.5" width="1.6" height="3" rx="0.8" />
  </Svg>
);
export const DiscIcon = (p: P) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth={2}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="2.5" fill="currentColor" />
  </Svg>
);
export const ClockIcon = (p: P) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);
export const MagnetIcon = (p: P) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 3v8a7 7 0 0 0 14 0V3h-4v8a3 3 0 0 1-6 0V3z" />
    <path d="M5 7h4M15 7h4" />
  </Svg>
);
export const ExitIcon = (p: P) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3" />
  </Svg>
);
export const ExpandIcon = (p: P) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
  </Svg>
);
export const DownloadIcon = ({ done, ...p }: P & { done?: boolean }) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9.5" fill={done ? "currentColor" : "none"} />
    <path d="M12 7v8M8.5 11.5 12 15l3.5-3.5" stroke={done ? "#000" : "currentColor"} />
  </Svg>
);
export const PhoneIcon = (p: P) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
    <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
  </Svg>
);

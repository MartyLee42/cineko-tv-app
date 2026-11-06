// Inline SVG icons (stroke = currentColor) and the Cineko mark.
import type { ReactNode } from "react";

function I({ children, size = 22, fill = false }: { children: ReactNode; size?: number; fill?: boolean }) {
  return (
    <svg
      className="ic"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type P = { size?: number };

export const IconHome = (p: P) => (
  <I {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V21h5v-6h4v6h5V9.5" />
  </I>
);
export const IconSearch = (p: P) => (
  <I {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </I>
);
export const IconHeart = ({ filled, ...p }: P & { filled?: boolean }) => (
  <I {...p} fill={filled}>
    <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
  </I>
);
export const IconClock = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </I>
);
export const IconGear = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </I>
);
export const IconPlay = (p: P) => (
  <I {...p} fill>
    <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z" />
  </I>
);
export const IconPause = (p: P) => (
  <I {...p} fill>
    <rect x="5.5" y="4" width="4.5" height="16" rx="1.2" />
    <rect x="14" y="4" width="4.5" height="16" rx="1.2" />
  </I>
);
export const IconBack = (p: P) => (
  <I {...p}>
    <path d="M15 5l-7 7 7 7" />
  </I>
);
export const IconChevron = (p: P) => (
  <I {...p}>
    <path d="M9 5l7 7-7 7" />
  </I>
);
export const IconNext = (p: P) => (
  <I {...p} fill>
    <path d="M5 5.5v13a1 1 0 0 0 1.6.8L15 13v5a1 1 0 0 0 2 0V6a1 1 0 0 0-2 0v5L6.6 4.7A1 1 0 0 0 5 5.5z" />
  </I>
);
export const IconPrev = (p: P) => (
  <I {...p} fill>
    <path d="M19 5.5v13a1 1 0 0 1-1.6.8L9 13v5a1 1 0 0 1-2 0V6a1 1 0 0 1 2 0v5l8.4-6.3A1 1 0 0 1 19 5.5z" />
  </I>
);
export const IconFullscreen = (p: P) => (
  <I {...p}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </I>
);
export const IconVolume = ({ muted, ...p }: P & { muted?: boolean }) => (
  <I {...p}>
    <path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4z" />
    {muted ? <path d="m16 9.5 5 5m0-5-5 5" /> : <path d="M16 8.5a5 5 0 0 1 0 7M18.8 6a8.5 8.5 0 0 1 0 12" />}
  </I>
);
export const IconStar = (p: P) => (
  <I {...p} fill>
    <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />
  </I>
);
export const IconClose = (p: P) => (
  <I {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </I>
);
export const IconMic = (p: P) => (
  <I {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </I>
);
export const IconLayers = (p: P) => (
  <I {...p}>
    <path d="m12 3 9 5-9 5-9-5z" />
    <path d="m3 13 9 5 9-5" />
  </I>
);
export const IconReplay = (p: P) => (
  <I {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </I>
);
export const IconTrash = (p: P) => (
  <I {...p}>
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
  </I>
);
export const IconFilm = (p: P) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
  </I>
);

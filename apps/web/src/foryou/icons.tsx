// Icons for the Phase 6 nav (24×24, currentColor; same style as ../icons).
import type { SVGProps } from "react";
import { CvIcon, useConstructivism } from "@martytv/ui";

export const CompassIcon = (p: SVGProps<SVGSVGElement>) =>
  useConstructivism() ? (
    <CvIcon glyph="compass" {...p} />
  ) : (
  <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2 5-5 2 2-5z" />
  </svg>
);

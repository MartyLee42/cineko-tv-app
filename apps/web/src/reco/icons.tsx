import type { SVGProps } from "react";
import { CvIcon, useConstructivism } from "@martytv/ui";

/** Speech bubble with a heart: "recommended to you". 24×24, currentColor. */
export function RecoIcon(p: SVGProps<SVGSVGElement>) {
  if (useConstructivism()) return <CvIcon glyph="reco" {...p} />;
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
      {...p}
    >
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12Z" />
      {/* Solid heart centred in the bubble (the bubble's centre is 13,12). */}
      <path
        d="M13 16.6C9.3 14.3 8.4 12.5 8.4 11a2.3 2.3 0 0 1 4.6-.9 2.3 2.3 0 0 1 4.6.9c0 1.5-.9 3.3-4.6 5.6Z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

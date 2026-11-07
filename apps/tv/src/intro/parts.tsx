// Pieces several intro scenes share.
import type { CSSProperties } from "react";
import { Mascot as MartyMascot } from "@martytv/ui";

export const delay = (s: number): CSSProperties => ({ animationDelay: `${s}s` });

/** Cineko (the neon robot-cat) in the intro; the old per-design colours no longer apply. */
export function Mascot({ size = 150 }: { color: string; ink: string; size?: number; cheeks?: boolean }) {
  return <MartyMascot size={size} hat={null} animated />;
}

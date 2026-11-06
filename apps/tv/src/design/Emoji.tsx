import { useSkin } from "./context";
import { waveGlyph } from "./waveIcons";

/** An emoji, drawn as neon line art in «Каркас» (falls back to the emoji). */
export function Emoji({ e, size }: { e: string; size: number }) {
  const wave = useSkin() === "wireframe";
  const art = wave ? waveGlyph(e, Math.round(size * 1.05)) : null;
  return art ? <span className="w-glyph inline-flex leading-none">{art}</span> : <>{e}</>;
}

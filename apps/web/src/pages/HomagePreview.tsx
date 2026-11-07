// Settings' tiny previews of the film-homage loading styles (the TV draws
// the real ones: apps/tv/src/player/loaders/*). Pure CSS shapes, looping.
import type { MessageKey } from "@martytv/ui";
import type { LoadingStyle } from "../watch/settings";
import "./homagePreview.css";

const HOMAGE: readonly LoadingStyle[] = ["water_glass", "poster_dig", "chocolate_box", "coffee_cup", "honey_pot", "hyperjump", "ghost_meter", "target_scan", "docking", "claw_machine"];

/** A film-homage style's name and hint (which film it nods to); null for the others. */
export function homageKeys(s: LoadingStyle): { name: MessageKey; hint: MessageKey } | null {
  if (!HOMAGE.includes(s)) return null;
  return { name: `loaders2.${s}` as MessageKey, hint: `loaders2.${s}_hint` as MessageKey };
}

/** The tile's drawing (inside LoadingPreview's 16:9 box). */
export function HomagePreview({ style }: { style: LoadingStyle }) {
  switch (style) {
    case "water_glass":
      return (
        <span className="absolute inset-0 flex items-end justify-center">
          <span className="absolute bottom-0 h-[22%] w-full bg-[#3a281c]" />
          <span className="relative mb-[14%] block h-[58%] w-[22%] rounded-b-md border-2 border-white/60 bg-sky-300/20">
            <span className="hp-ring absolute left-[10%] top-[20%] block h-[14%] w-[80%] rounded-[50%] border border-white" />
            <span className="hp-ring absolute left-[10%] top-[20%] block h-[14%] w-[80%] rounded-[50%] border border-white [animation-delay:.7s]" />
          </span>
        </span>
      );
    case "poster_dig":
      return (
        <span className="absolute inset-0 flex items-center justify-center bg-[#8a857a]">
          <span className="absolute h-[80%] w-[34%] rounded-[30%] bg-black/80" />
          <span className="hp-tear-l absolute block h-[70%] w-[13%] -translate-x-[50%] bg-[linear-gradient(160deg,#f97316,#7c2d12)]" />
          <span className="hp-tear-r absolute block h-[70%] w-[13%] translate-x-[50%] bg-[linear-gradient(200deg,#f97316,#7c2d12)]" />
        </span>
      );
    case "chocolate_box":
      return (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="grid grid-cols-4 gap-1 rounded-md bg-[#7a1522] p-1.5 ring-2 ring-[#d8b25a]">
            {Array.from({ length: 8 }, (_, i) => (
              <span key={i} className="hp-choc block h-4 w-4 rounded-full bg-[#5a3420]" style={{ animationDelay: `${i * 0.35}s` }} />
            ))}
          </span>
        </span>
      );
    case "coffee_cup":
      return (
        <span className="absolute inset-0 flex items-end justify-center bg-[#6b0f14]">
          <span className="absolute bottom-0 h-[24%] w-full bg-[repeating-linear-gradient(135deg,#111_0_6px,#eee_6px_12px)]" />
          <span className="relative mb-[12%] block h-[44%] w-[22%] overflow-hidden rounded-b-lg bg-[#f4f0ea]">
            <span className="hp-fill absolute bottom-0 left-[10%] block h-[85%] w-[80%] origin-bottom rounded-b-md bg-[#5b3418]" />
          </span>
        </span>
      );
    case "honey_pot":
      return (
        <span className="absolute inset-0 flex items-end justify-center bg-[linear-gradient(180deg,#8fc6e8_0_62%,#5d9440_62%)]">
          <span className="relative mb-[10%] block h-[48%] w-[24%] overflow-hidden rounded-b-[40%] rounded-t-md bg-[#b4673a]">
            <span className="hp-fill absolute bottom-0 block h-full w-full origin-bottom bg-[#f2a20c]" />
          </span>
          <span className="hp-bee absolute left-[30%] top-[22%] block h-2 w-3 rounded-full bg-[repeating-linear-gradient(90deg,#ffcc1a_0_3px,#1d1a14_3px_5px)]" />
          <span className="hp-bee absolute right-[28%] top-[34%] block h-2 w-3 rounded-full bg-[repeating-linear-gradient(90deg,#ffcc1a_0_3px,#1d1a14_3px_5px)] [animation-delay:.5s]" />
        </span>
      );
    case "hyperjump":
      return (
        <span className="absolute inset-0 overflow-hidden bg-[#05070d]">
          {Array.from({ length: 14 }, (_, i) => (
            <span key={i} className="absolute left-1/2 top-1/2 block h-px w-1 origin-left" style={{ transform: `rotate(${i * 26}deg) translateX(${14 + (i % 4) * 12}px)` }}>
              <span className="hp-streak block h-px w-full origin-left bg-white" />
            </span>
          ))}
        </span>
      );
    case "ghost_meter":
      return (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="relative block h-[62%] w-[36%] rounded-lg bg-[#45494d] p-1.5">
            <span className="relative block h-[55%] w-full overflow-hidden rounded-t-full bg-[#efe6cf]">
              <span className="hp-needle absolute bottom-0 left-1/2 block h-[90%] w-0.5 origin-bottom bg-[#c1121f]" />
            </span>
            <span className="mt-1 flex justify-between">
              {["#4ade80", "#facc15", "#fb923c", "#ef4444"].map((c, i) => (
                <span key={c} className="hp-lamp block h-1.5 w-1.5 rounded-full" style={{ background: c, animationDelay: `${i * 0.3}s` }} />
              ))}
            </span>
          </span>
        </span>
      );
    case "target_scan":
      return (
        <span className="absolute inset-0 bg-[#7a0a0a] font-mono text-white">
          <span className="absolute left-2 top-2 text-[9px] leading-tight">
            ЦЕЛЬ: КИНО
            <br />
            АНАЛИЗ… 87%
          </span>
          <span className="absolute right-[18%] top-[18%] block h-[64%] w-[26%] overflow-hidden border-2 border-white/90">
            <span className="hp-scan block h-0.5 w-full bg-white" />
          </span>
        </span>
      );
    case "docking":
      return (
        <span className="absolute inset-0 flex items-center justify-center bg-[#04060b]">
          <span className="hp-spin block h-[64%] w-[36%] rounded-full border-[5px] border-dotted border-[#cfd5db]" />
          <span className="hp-dock absolute block h-2 w-2 rounded-sm bg-white" />
        </span>
      );
    case "claw_machine":
      return (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="relative block h-[80%] w-[56%] overflow-hidden rounded-md bg-[#2c3c63] ring-4 ring-[#e0457b]">
            <span className="absolute bottom-0 left-0 flex w-full justify-around">
              {["#f87171", "#60a5fa", "#facc15", "#34d399", "#c084fc"].map((c) => (
                <span key={c} className="block h-3 w-3 rounded-full" style={{ background: c }} />
              ))}
            </span>
            <span className="hp-claw absolute left-1/2 top-0 block h-[40%] w-0.5 origin-top bg-[#9aa3ab]" />
          </span>
        </span>
      );
    default:
      return null;
  }
}

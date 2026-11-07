// «Тамагочи»: the app is the toy's LCD (tokens in theme.css), framed by the
// pastel plastic shell (a static SVG over the content's edges, under the
// menu); the brand, three toy buttons and a speaker grille sit on its bottom
// band around the ticker's little LCD strip. On Home, Cineko lives in a
// corner of the screen as a pixel pet who is happier the more the profile
// watched this week (0–4 hearts).
import "./pocketpet.css";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@martytv/ui";
import { storage } from "../../platform";
import { useHistory } from "../../foryou/queries";
import { useActiveProfileId } from "../../profile/active";
import { useCalmMotion } from "../skins";
import type { Look } from "./types";
import { layer } from "./common";
import { petAte, petHearts, petMood, petScore } from "./pocketpetMood";
import { BODY, CHEST, dots, FACE, HEART, HEART_EMPTY, INK, LCD, pixels, POPCORN, SPARKLE, type Face } from "./pocketpetSprites";

// ================================================================ the pet

/** The pet itself (16×15 pixels plus room for sparkles / the popcorn). */
export function PetSprite({ face, px = 8, moving }: { face: Face; px?: number; moving: boolean }) {
  // viewBox: room around the 16×15 body for the sparkles and the popcorn.
  return (
    <svg width={24 * px} height={18 * px} viewBox="-3 -3 24 18" shapeRendering="crispEdges" className="block" aria-hidden>
      <g className={moving ? "pp-bob" : undefined}>
        <path d={pixels(BODY)} fill={INK} />
        <path d={dots(FACE[face]) + dots(CHEST)} fill={LCD} />
      </g>
      {face === "ecstatic" && (
        <>
          <path className={moving ? "pp-blink" : undefined} d={pixels(SPARKLE, "#", -3, -2)} fill={INK} />
          <path className={moving ? "pp-blink pp-blink-2" : undefined} d={pixels(SPARKLE, "#", 17, 0)} fill={INK} />
        </>
      )}
      {face === "eat" && <path className={moving ? "pp-feed" : undefined} d={pixels(POPCORN, "#", 16, 9)} fill={INK} />}
    </svg>
  );
}

/** 0–4 hearts: filled = happiness, outlines = the rest. */
export function Hearts({ n, px = 4 }: { n: number; px?: number }) {
  let full = "";
  let empty = "";
  for (let i = 0; i < 4; i++) {
    if (i < n) full += pixels(HEART, "#", i * 9);
    else empty += pixels(HEART_EMPTY, "#", i * 9);
  }
  return (
    <svg width={34 * px} height={6 * px} viewBox="0 0 34 6" shapeRendering="crispEdges" className="block" aria-hidden>
      <path d={full} fill={INK} />
      <path d={empty} fill={INK} opacity={0.55} />
    </svg>
  );
}

// ================================================================ the pet on Home

const FED_KEY = "martytv.pocketpet.score.";
const SLEEP_AFTER_MS = 60_000;
const EAT_MS = 4500;

function usePetState() {
  const profile = useActiveProfileId();
  const history = useHistory();
  const items = history.data?.pages[0]?.items;
  const score = useMemo(() => (items ? petScore(items, new Date()) : null), [items]);
  const [eating, setEating] = useState(false);
  useEffect(() => {
    if (score === null || !profile) return;
    const key = FED_KEY + profile;
    const before = storage.get(key);
    storage.set(key, String(score));
    if (!petAte(before === null ? null : Number(before), score)) return;
    // A popcorn for a few seconds (timers: the effect itself doesn't set state).
    const on = window.setTimeout(() => setEating(true), 0);
    const off = window.setTimeout(() => setEating(false), EAT_MS);
    return () => {
      clearTimeout(on);
      clearTimeout(off);
      setEating(false);
    };
  }, [score, profile]);
  return { hearts: score === null ? null : petHearts(score), eating };
}

/** Dozes off after a minute without keys on Home (Zz); any key wakes it. */
function useSleepy(on: boolean): boolean {
  const [asleep, setAsleep] = useState(false);
  useEffect(() => {
    if (!on) return;
    let id = 0;
    const wake = () => {
      setAsleep(false);
      clearTimeout(id);
      id = window.setTimeout(() => setAsleep(true), SLEEP_AFTER_MS);
    };
    wake();
    window.addEventListener("keydown", wake);
    return () => {
      clearTimeout(id);
      window.removeEventListener("keydown", wake);
    };
  }, [on]);
  return on && asleep;
}

function PocketPet({ onHome }: { onHome: boolean }) {
  const { t } = useI18n();
  const calm = useCalmMotion();
  const { hearts, eating } = usePetState();
  const asleep = useSleepy(onHome);
  if (!onHome || hearts === null) return null;
  const mood = petMood(hearts);
  const face: Face = eating ? "eat" : asleep ? "sleep" : mood;
  return (
    <div data-testid="pocket-pet" data-mood={mood} data-face={face} role="img" aria-label={t("pocketpet.label", { n: hearts })} className="pp-pet pointer-events-none absolute z-[19]">
      <div className="pp-hearts">
        <Hearts n={hearts} />
      </div>
      <div className="pp-sprite">
        <PetSprite face={face} px={7} moving={!calm} />
        {face === "sleep" && (
          <span className={`pp-zz ${calm ? "" : "pp-zz-on"}`} aria-hidden>
            Z<small>z</small>
          </span>
        )}
      </div>
      <p className="pp-caption">{eating ? t("pocketpet.yum") : t(`pocketpet.mood.${mood}` as const)}</p>
    </div>
  );
}

// ================================================================ the shell

const PINK = "#f3c6dc";
const SHELL_PATH = "M0 0H1920V1080H0Z M48 14H1872A34 34 0 0 1 1906 48V1002A34 34 0 0 1 1872 1036H48A34 34 0 0 1 14 1002V48A34 34 0 0 1 48 14Z";

/** Speaker grille: rows of little holes on the bottom-right of the shell. */
const GRILLE = (() => {
  let d = "";
  for (let r = 0; r < 3; r++) for (let c = 0; c < 16; c++) d += `M${1664 + c * 14 + (r % 2) * 7} ${1047 + r * 10}h5v5h-5z`;
  return d;
})();

/** The pastel plastic toy around the LCD (static, one SVG). */
function Shell() {
  return (
    <svg data-skin-bg-shell className={`${layer} pp-shell`} width={1920} height={1080} viewBox="0 0 1920 1080" aria-hidden>
      <defs>
        <linearGradient id="pp-plastic" x1="0" y1="0" x2="0.25" y2="1">
          <stop offset="0" stopColor="#f8d6e6" />
          <stop offset="0.55" stopColor={PINK} />
          <stop offset="1" stopColor="#e3b9dc" />
        </linearGradient>
        <radialGradient id="pp-btn-a" cx="0.38" cy="0.32" r="0.7">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.35" stopColor="#bff0da" />
          <stop offset="1" stopColor="#7cc9a8" />
        </radialGradient>
        <radialGradient id="pp-btn-b" cx="0.38" cy="0.32" r="0.7">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.35" stopColor="#ddd0fa" />
          <stop offset="1" stopColor="#a893dd" />
        </radialGradient>
        <radialGradient id="pp-btn-c" cx="0.38" cy="0.32" r="0.7">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.35" stopColor="#fff1b8" />
          <stop offset="1" stopColor="#e8c76c" />
        </radialGradient>
      </defs>
      <path d={SHELL_PATH} fill="url(#pp-plastic)" fillRule="evenodd" />
      {/* The LCD sits a little deeper: a lilac lip and a soft shade along its top. */}
      <rect x={14} y={14} width={1892} height={1022} rx={34} fill="none" stroke="#c7a6d6" strokeWidth={4} />
      <rect x={18} y={18} width={1884} height={1014} rx={31} fill="none" stroke="rgba(40,48,30,.16)" strokeWidth={5} />
      {/* Embossed brand. */}
      <g fontFamily="'Press Start 2P', 'JetBrains Mono', monospace" fontSize={24}>
        <text x={60} y={1067} fill="#ffffff" opacity={0.85}>Cineko</text>
        <text x={64} y={1071} fill="#c493b4">Cineko</text>
        <text x={62} y={1069} fill="#ecb8d4">Cineko</text>
      </g>
      {/* Three toy buttons (A · B · C). */}
      {["a", "b", "c"].map((b, i) => (
        <g key={b}>
          <circle cx={1404 + i * 70} cy={1060} r={16} fill="rgba(120,70,110,.28)" />
          <circle cx={1404 + i * 70} cy={1057} r={15} fill={`url(#pp-btn-${b})`} />
        </g>
      ))}
      <path d={GRILLE} fill="#c99bbb" />
    </svg>
  );
}

/** The LCD: grey-green with faint unlit pixel cells and a soft reflection; the shell over its edges. */
function LcdBackground() {
  return (
    <>
      <div data-skin-bg="lcd" className={`pp-lcd ${layer}`}>
        <div className="pp-glare absolute left-0 top-0 h-full w-full" />
      </div>
      <Shell />
    </>
  );
}

export const look: Look = { Background: () => <LcdBackground />, Companion: PocketPet };

// The season layer shared by the TV app and the PWA: a pointer-events-free
// overlay of a few falling / rising / flying SVG sprites, plus static
// accents (New Year's garland, St George ribbon, willow, pumpkins), the
// mascot's hat and a once-per-season greeting.
//
// Performance: every moving particle is one element animated with a
// transform-only CSS keyframe (its own compositor layer, no layout or
// paint per frame); delays, durations, sizes and drift are precomputed
// once per season from a seeded PRNG. The container has `contain: strict`.
// Counts stay small (TV ≤ 18, web ≤ 24). "static" draws a few sprites in
// place with no animation; the hidden page pauses every animation.
import { memo, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n, type MessageKey } from "./i18n";
import { greetingKey, type SeasonId } from "./seasons";
import { MascotHat, Pumpkins, RibbonLoop, SeasonSprite, WillowBranch, type SpriteId } from "./seasonSprites";
import { setSeasonHat, useDocumentHidden, type MascotHatId } from "./seasonStore";

export { MascotHat };

type Motion = "fall" | "rise" | "fly" | "none";
type Accent = "garland" | "ribbon" | "willow" | "pumpkins" | "warm";

/** The look of a season: sprites, motion and counts (TV px; web scales). */
interface Look {
  sprites: SpriteId[];
  motion: Motion;
  /** Moving particles on TV (web: ×4/3, ≤ 24; phones fewer). */
  count: number;
  size: [number, number];
  /** Seconds for one pass. */
  speed: [number, number];
  opacity: [number, number];
  /** Random tilt of each sprite (degrees, ±). */
  tilt: number;
  /** Twinkling stars drawn in place (counted in the TV budget). */
  stars?: { sprite: SpriteId; count: number; size: [number, number] };
  /** One rocket crossing now and then (Cosmonautics Day). */
  rocket?: boolean;
  accents: Accent[];
  hat: MascotHatId;
}

const LOOKS: Record<SeasonId, Look> = {
  newyear: { sprites: ["flake", "flake2", "snowdot", "snowdot"], motion: "fall", count: 18, size: [16, 36], speed: [10, 17], opacity: [0.55, 0.9], tilt: 30, accents: ["garland"], hat: "santa" },
  christmas: {
    sprites: ["flake", "flake2", "snowdot"],
    motion: "fall",
    count: 14,
    size: [16, 32],
    speed: [11, 18],
    opacity: [0.5, 0.85],
    tilt: 30,
    stars: { sprite: "goldstar", count: 4, size: [30, 44] },
    accents: ["garland"],
    hat: "santa",
  },
  oldnewyear: { sprites: ["flake2", "snowdot"], motion: "fall", count: 9, size: [12, 24], speed: [13, 20], opacity: [0.45, 0.75], tilt: 30, accents: [], hat: null },
  valentine: { sprites: ["heart", "heart2"], motion: "rise", count: 10, size: [26, 44], speed: [13, 21], opacity: [0.5, 0.85], tilt: 14, accents: [], hat: null },
  defender: { sprites: ["redstar"], motion: "fall", count: 7, size: [18, 28], speed: [18, 26], opacity: [0.35, 0.6], tilt: 20, accents: [], hat: null },
  maslenitsa: { sprites: ["sun", "pancake", "pancake"], motion: "rise", count: 12, size: [36, 60], speed: [15, 23], opacity: [0.75, 0.95], tilt: 25, accents: ["warm"], hat: null },
  women: { sprites: ["mimosa", "tulip", "mimosa"], motion: "fall", count: 12, size: [30, 48], speed: [13, 19], opacity: [0.7, 0.95], tilt: 35, accents: [], hat: null },
  cosmonautics: { sprites: [], motion: "none", count: 0, size: [0, 0], speed: [0, 0], opacity: [1, 1], tilt: 0, stars: { sprite: "sparkle", count: 9, size: [12, 22] }, rocket: true, accents: [], hat: null },
  easter: { sprites: ["egg1", "egg2", "egg3"], motion: "fall", count: 9, size: [28, 42], speed: [15, 21], opacity: [0.8, 0.95], tilt: 25, accents: ["willow"], hat: null },
  // Dignified: no particles, no hat, no greeting toast — the ribbon and a still badge.
  victory: { sprites: [], motion: "none", count: 0, size: [0, 0], speed: [0, 0], opacity: [1, 1], tilt: 0, accents: ["ribbon"], hat: null },
  russia: { sprites: ["confetti1", "confetti2", "confetti3"], motion: "fall", count: 14, size: [12, 20], speed: [10, 15], opacity: [0.55, 0.8], tilt: 80, accents: [], hat: null },
  knowledge: { sprites: ["leaf1", "leaf2", "leaf3"], motion: "fall", count: 12, size: [30, 46], speed: [12, 18], opacity: [0.75, 0.95], tilt: 60, accents: [], hat: null },
  halloween: { sprites: ["bat"], motion: "rise", count: 9, size: [56, 88], speed: [12, 19], opacity: [0.8, 1], tilt: 12, accents: ["pumpkins"], hat: "witch" },
};

/** The sprite shown next to a season's greeting. */
const GREETING_SPRITE: Record<SeasonId, SpriteId | null> = {
  newyear: "flake",
  christmas: "goldstar",
  oldnewyear: "flake2",
  valentine: "heart",
  defender: "redstar",
  maslenitsa: "sun",
  women: "mimosa",
  cosmonautics: "sparkle",
  easter: "egg1",
  victory: null,
  russia: "confetti2",
  knowledge: "leaf1",
  halloween: "bat",
};

export const TV_MAX_PARTICLES = 18;
export const WEB_MAX_PARTICLES = 24;

/** Deterministic PRNG (Park–Miller) seeded by the season id. */
function rng(seed: string) {
  let s = 7;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) % 2147483647;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

interface Particle {
  sprite: SpriteId;
  left: number; // %
  top: number; // % (static / stars)
  size: number;
  dur: number;
  delay: number;
  opacity: number;
  rot: number;
  path: "a" | "b" | "c";
}

export type SeasonPlatform = "tv" | "web";

/** How many moving particles a season draws (TV ≤ 18; web ≤ 24, phones about half). */
export function particleCount(id: SeasonId, platform: SeasonPlatform, narrow = false): number {
  const l = LOOKS[id];
  const stars = l.stars?.count ?? 0;
  const rocket = l.rocket ? 1 : 0;
  if (platform === "tv") return Math.max(0, Math.min(l.count, TV_MAX_PARTICLES - stars - rocket));
  const web = Math.min(Math.round((l.count * 4) / 3), WEB_MAX_PARTICLES - stars - rocket);
  return narrow ? Math.ceil(web / 2) : web;
}

/** Precomputed particles (stable per season / platform / mode). */
export function makeParticles(id: SeasonId, platform: SeasonPlatform, still: boolean, narrow = false, intensity = 1): { moving: Particle[]; stars: Particle[] } {
  const l = LOOKS[id];
  const r = rng(`${id}:${platform}`);
  const scale = platform === "tv" ? 1 : 0.62;
  const between = ([a, b]: [number, number]) => a + r() * (b - a);
  let n = particleCount(id, platform, narrow);
  // Lead-up days ramp up (intensity < 1); still mode draws about half.
  if (n > 0) n = Math.max(1, Math.round(n * Math.min(1, Math.max(0, intensity))));
  if (still) n = Math.ceil(n * 0.55);
  const moving: Particle[] = [];
  for (let i = 0; i < n; i++) {
    const dur = between(l.speed);
    moving.push({
      sprite: l.sprites[i % l.sprites.length]!,
      // Spread evenly across the width with jitter (no clumps).
      left: Math.min(97, ((i + 0.15 + r() * 0.7) / n) * 100),
      top: 6 + r() * 84,
      size: Math.round(between(l.size) * scale),
      dur: Math.round(dur * 10) / 10,
      // Negative delays: the screen is already populated on mount.
      delay: -Math.round(r() * dur * 10) / 10,
      opacity: Math.round(between(l.opacity) * 100) / 100,
      rot: Math.round((r() * 2 - 1) * l.tilt),
      path: (["a", "b", "c"] as const)[i % 3]!,
    });
  }
  const stars: Particle[] = [];
  for (let i = 0; i < (l.stars?.count ?? 0); i++) {
    stars.push({
      sprite: l.stars!.sprite,
      left: 6 + ((i + r() * 0.8) / l.stars!.count) * 88,
      // Upper part of the screen, away from the rows.
      top: 6 + r() * 34,
      size: Math.round(between(l.stars!.size) * scale),
      dur: Math.round((2.6 + r() * 2.4) * 10) / 10,
      delay: -Math.round(r() * 40) / 10,
      opacity: 1,
      rot: 0,
      path: "a",
    });
  }
  return { moving, stars };
}

export function seasonHat(id: SeasonId): MascotHatId {
  return LOOKS[id].hat;
}

export interface SeasonLayerProps {
  season: SeasonId;
  mode: "full" | "static";
  platform: SeasonPlatform;
  /** A preview (Settings): no hat, no greeting, nothing global. */
  preview?: boolean;
  /** The once-per-season greeting (stored per device): "day" on the holiday, "soon" during the lead-up. */
  greeting?: { phase: "day" | "soon"; year: number } | null;
  /** 0.45 … 1: fewer particles in the lead-up days. */
  intensity?: number;
  /** On the holiday's main days (День Победы's badge shows then only). */
  main?: boolean;
  /** Web: fixed to the viewport (default); TV / previews: absolute in the parent. */
  fixed?: boolean;
  /** Narrow (phone) viewport: fewer particles. */
  narrow?: boolean;
}

/**
 * The overlay. Put it above the page's background and content, below
 * dialogs (TV: before the menu / settings in the DOM; web: z-index 15).
 */
export const SeasonLayer = memo(function SeasonLayer({ season, mode, platform, preview = false, greeting = null, intensity = 1, main = true, fixed = platform === "web", narrow = false }: SeasonLayerProps) {
  const look = LOOKS[season];
  const still = mode === "static";
  const hidden = useDocumentHidden();
  const ramp = Math.round(intensity * 20) / 20; // stable memo key
  const parts = useMemo(() => makeParticles(season, platform, still, narrow, ramp), [season, platform, still, narrow, ramp]);

  // The mascot's hat follows the live layer (not previews).
  useEffect(() => {
    if (preview) return;
    setSeasonHat(look.hat);
    return () => setSeasonHat(null);
  }, [preview, look.hat]);

  const cls = `mt-ss mt-ss-${platform} ${fixed ? "mt-ss-fixed" : ""} ${still ? "mt-ss-still" : ""}`;
  return (
    <div className={cls} data-season={season} data-season-mode={mode} data-paused={hidden ? "1" : undefined}>
      {look.accents.includes("warm") && <div className="mt-ss-warm" />}
      {look.accents.includes("garland") && <Garland still={still} platform={platform} />}
      {look.accents.includes("ribbon") && <div className="mt-ss-ribbon" />}
      {/* «Верба»: TV top-left (clear of the rail; the status corner is top-right); web desktop under the header on the right, none on phones (it would cover the logo). */}
      {look.accents.includes("willow") && platform === "tv" && (
        <div className="mt-ss-corner mt-ss-tl">
          <WillowBranch width={260} />
        </div>
      )}
      {look.accents.includes("willow") && platform === "web" && !narrow && (
        <div className="mt-ss-corner mt-ss-tr mt-ss-flip">
          <WillowBranch width={170} />
        </div>
      )}
      {look.accents.includes("pumpkins") && (
        <div className="mt-ss-corner mt-ss-br">
          <Pumpkins width={platform === "tv" ? 150 : narrow ? 84 : 120} />
        </div>
      )}
      {parts.stars.map((p, i) => (
        <span key={`s${i}`} className={`mt-ss-star ${still ? "" : "mt-ss-tw"}`} style={{ left: `${p.left}%`, top: `${p.top}%`, animationDuration: `${p.dur}s`, animationDelay: `${p.delay}s` }}>
          <SeasonSprite id={p.sprite} s={p.size} />
        </span>
      ))}
      {look.rocket && <Rocket still={still} platform={platform} />}
      {parts.moving.map((p, i) =>
        still ? (
          <span key={i} className="mt-ss-dot" style={{ left: `${p.left}%`, top: `${p.top}%`, opacity: p.opacity * 0.85 }}>
            <SeasonSprite id={p.sprite} s={p.size} rot={p.rot} />
          </span>
        ) : (
          <span
            key={i}
            className={`mt-ss-p mt-ss-${look.motion} mt-ss-${look.motion}-${p.path}`}
            style={{ left: `${p.left}%`, width: p.size, opacity: p.opacity, animationDuration: `${p.dur}s`, animationDelay: `${p.delay}s` }}
          >
            <SeasonSprite id={p.sprite} s={p.size} rot={p.rot} />
          </span>
        ),
      )}
      {season === "victory" && main && <VictoryBadge platform={platform} />}
      {greeting && !preview && season !== "victory" && <Greeting season={season} platform={platform} phase={greeting.phase} year={greeting.year} />}
    </div>
  );
});

/** Garland along the top edge: a sagging wire with bulbs; two bulb sets blink in turn (2 animated layers). */
function Garland({ still, platform }: { still: boolean; platform: SeasonPlatform }) {
  const tv = platform === "tv";
  const w = tv ? 240 : 150;
  const h = tv ? 46 : 26;
  const sag = tv ? 26 : 13;
  const r = tv ? 6 : 3.6;
  const colors = ["#ff5a5a", "#ffd84d", "#4fd1ff", "#7dff7a", "#ff8ae6"];
  // Bulbs along the arc (quadratic: B(t) = (1-t)²P0 + 2t(1-t)P1 + t²P2).
  const pt = (t: number) => ({ x: w * t, y: 2 + 2 * t * (1 - t) * (sag * 2) });
  const bulbs = [0.12, 0.34, 0.56, 0.78].map((t, i) => ({ ...pt(t), c: colors[i % colors.length]!, odd: i % 2 === 1 }));
  const tile = (set: "wire" | "a" | "b") => (
    <svg className={`mt-ss-garland-svg ${set !== "wire" && !still ? `mt-ss-blink-${set}` : ""}`} width="100%" height={h + r * 2} aria-hidden focusable="false">
      <defs>
        <pattern id={`mt-ss-g-${platform}-${set}`} width={w} height={h + r * 2} patternUnits="userSpaceOnUse">
          {set === "wire" ? (
            <path d={`M0 2 Q${w / 2} ${2 + sag * 2} ${w} 2`} stroke="#1f3b2a" strokeWidth={tv ? 2.4 : 1.6} fill="none" />
          ) : (
            bulbs
              .filter((b) => b.odd === (set === "b"))
              .map((b, i) => (
                <g key={i}>
                  <rect x={b.x - r * 0.45} y={b.y - 1} width={r * 0.9} height={r * 0.8} fill="#2d4a37" />
                  <ellipse cx={b.x} cy={b.y + r * 1.2} rx={r * 0.78} ry={r} fill={b.c} />
                  <ellipse cx={b.x - r * 0.25} cy={b.y + r * 0.9} rx={r * 0.22} ry={r * 0.35} fill="#fff" opacity=".7" />
                </g>
              ))
          )}
        </pattern>
      </defs>
      <rect x="0" y="0" width="100%" height="100%" fill={`url(#mt-ss-g-${platform}-${set})`} />
    </svg>
  );
  return (
    <div className="mt-ss-garland">
      {tile("wire")}
      {tile("a")}
      {tile("b")}
    </div>
  );
}

/** A rocket crossing the upper part now and then (one layer; still: parked in a corner). */
function Rocket({ still, platform }: { still: boolean; platform: SeasonPlatform }) {
  const s = platform === "tv" ? 150 : 72;
  if (still)
    return (
      <span className="mt-ss-dot" style={{ right: "6%", top: "14%" }}>
        <SeasonSprite id="rocket" s={s} rot={-14} />
      </span>
    );
  return (
    <span className="mt-ss-fly" style={{ top: "18%", height: s }}>
      <SeasonSprite id="rocket" s={s} rot={-8} />
    </span>
  );
}

/** «С Днём Победы»: a still badge with the ribbon loop (no motion, no dismiss timer). */
function VictoryBadge({ platform }: { platform: SeasonPlatform }) {
  const { t } = useI18n();
  return (
    <div className={`mt-ss-badge mt-ss-badge-${platform}`} data-testid="season-victory-badge">
      <RibbonLoop size={platform === "tv" ? 34 : 18} />
      <span className="mt-ss-badge-text">{t("seasons.greeting.victory")}</span>
    </div>
  );
}

function readGreeted(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return true; // no storage: never nag
  }
}

function writeGreeted(key: string) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // storage unavailable
  }
}

/** The once-per-season greeting: auto-hides (TV 6 s, web 8 s); web has ×, TV hides on any key. */
function Greeting({ season, platform, phase, year }: { season: SeasonId; platform: SeasonPlatform; phase: "day" | "soon"; year: number }) {
  const { t } = useI18n();
  const key = greetingKey({ id: season, year }, phase);
  const [show, setShow] = useState(() => !readGreeted(key));
  useEffect(() => {
    if (!show) return;
    writeGreeted(key);
    const id = setTimeout(() => setShow(false), platform === "tv" ? 6000 : 8000);
    const onKey = () => setShow(false);
    if (platform === "tv") window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [show, key, platform]);
  if (!show) return null;
  const soon = phase === "soon";
  const sprite = GREETING_SPRITE[season];
  return (
    <div className={`mt-ss-toast mt-ss-toast-${platform} ${soon ? "mt-ss-toast-soon" : ""}`} role="status" data-testid="season-greeting" data-phase={phase}>
      {sprite && (
        <span className="mt-ss-toast-icon">
          <SeasonSprite id={sprite} s={platform === "tv" ? 38 : 22} />
        </span>
      )}
      <span>{phase === "day" ? t(`seasons.greeting.${season}` as MessageKey) : t("seasons.soon", { name: t(`seasons.name.${season}` as MessageKey) })}</span>
      {platform === "web" && (
        <button type="button" className="mt-ss-toast-x" aria-label={t("seasons.dismiss")} onClick={() => setShow(false)}>
          ×
        </button>
      )}
    </div>
  );
}

/**
 * A scaled-down live preview of a season on a 1920×1080 TV canvas (TV
 * Settings): `width` px wide, with `children` drawn over it.
 */
export function SeasonPreviewBox({ season, mode, width, children }: { season: SeasonId; mode: "full" | "static"; width: number; children?: ReactNode }) {
  const scale = width / 1920;
  const box: CSSProperties = { width, height: Math.round(1080 * scale), position: "relative", overflow: "hidden" };
  return (
    <div className="mt-ss-previewbox" style={box} data-testid="season-preview-box">
      <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, transform: `scale(${scale})`, transformOrigin: "0 0" }}>
        <SeasonLayer season={season} mode={mode} platform="tv" preview fixed={false} />
      </div>
      {children}
    </div>
  );
}

import type { ReactNode } from "react";
import { MascotHat } from "./mascotHat";
import { MARTY_ANIMATED, MARTY_MOODS, MAYAKOVSKY, type MascotMood } from "./marty";
import { useSeasonHat, type MascotHatId } from "./seasonStore";
import { useAppliedDesign } from "./designs";
import { costumePlan } from "./mascotCostume";
import { CostumeArt } from "./MascotCostume";
import { useI18nOptional } from "./i18n";

/** Circle with a profile's initial and color (or emoji avatar). */
export function ProfileAvatar({
  name,
  color,
  avatar,
  size = 64,
  className = "",
}: {
  name: string;
  color: string;
  avatar?: string;
  size?: number;
  className?: string;
}) {
  const label = avatar || (name.trim()[0] ?? "?").toUpperCase();
  return (
    <div
      aria-hidden
      className={`flex shrink-0 select-none items-center justify-center rounded-2xl font-semibold text-white ${className}`}
      style={{ width: size, height: size, background: color, fontSize: size * 0.45 }}
    >
      {label}
    </div>
  );
}

export function Spinner({ size = 24 }: { size?: number }) {
  return (
    <span
      role="status"
      aria-label="loading"
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent"
      style={{ width: size, height: size }}
    />
  );
}

export function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-2.5 w-2.5 rounded-full ${online ? "bg-ok shadow-[0_0_8px] shadow-ok" : "bg-muted"}`}
    />
  );
}

/**
 * Cineko, the Cineko mascot: a neon robot-cat (brand refresh, Oct 2026).
 * `mood` picks a sticker (idle, happy, sleepy, popcorn…). Moods with a loop
 * (idle, happy, sleepy, popcorn, thinking, loading) animate when big (≥ 80 px)
 * or with `animated`, unless the user prefers reduced motion. `color` / `screen` / `cheeks` are from the old
 * TV-shaped mascot and are ignored.
 */
export function Mascot({
  size = 40,
  className = "",
  hat,
  mood = "idle",
  animated,
  alt = "",
  costume = true,
}: {
  size?: number;
  /** @deprecated old SVG mascot; ignored. */
  color?: string;
  /** @deprecated old SVG mascot; ignored. */
  screen?: string;
  /** @deprecated old SVG mascot; ignored. */
  cheeks?: boolean;
  className?: string;
  /** A seasonal hat; by default the live season layer's (Santa at New Year, a witch's at Halloween). `null` = none. */
  hat?: MascotHatId;
  mood?: MascotMood;
  animated?: boolean;
  alt?: string;
  /** The design's costume (top hat, visor, sunglasses…); false = the plain sticker. */
  costume?: boolean;
}) {
  const live = useSeasonHat();
  const design = useAppliedDesign();
  const i18n = useI18nOptional();
  // «Конструктивизм»: Mayakovsky (a poster tile, slightly tilted) stands in for Cineko — same box, so layouts keep their shape.
  if (design === "constructivism") {
    return (
      <span
        className={`relative inline-flex shrink-0 items-center justify-center align-middle ${className}`}
        style={size ? { width: size, height: size } : undefined}
        data-mascot="mayakovsky"
        aria-hidden={alt ? undefined : true}
      >
        <img
          src={MAYAKOVSKY}
          alt={alt}
          draggable={false}
          decoding="async"
          className="mt-mayakovsky pointer-events-none block h-full w-auto max-w-none select-none"
          style={{ aspectRatio: "378 / 499", transform: "rotate(-3deg)", boxShadow: "3px 3px 0 #1a1512", outline: "2px solid #efe4cc", outlineOffset: -2 }}
        />
      </span>
    );
  }
  const worn = hat === undefined ? live : hat;
  const plan = costume ? costumePlan(design, worn, mood) : null;
  const loop = MARTY_ANIMATED[mood];
  // Head and face costumes sit on the still sticker (the loop's frames move).
  const anim = !!loop && !plan?.still && (animated ?? size >= 80) && !prefersReducedMotion();
  const src = anim ? loop : MARTY_MOODS[mood];
  return (
    <span
      className={`relative inline-block shrink-0 align-middle ${className}`}
      style={size ? { width: size, height: size } : undefined}
      data-mascot={mood}
      data-costume={plan?.costume}
      aria-hidden={alt ? undefined : true}
    >
      <img src={src} alt={alt} draggable={false} decoding="async" className="pointer-events-none block h-full w-full select-none object-contain" />
      {worn && (
        <svg viewBox="0 0 120 120" className="pointer-events-none absolute left-0 top-0 h-full w-full overflow-visible" aria-hidden>
          <g transform="translate(14 -6) scale(0.78)">
            <MascotHat hat={worn} />
          </g>
        </svg>
      )}
      {plan && <CostumeArt plan={plan} bubble={i18n ? i18n.t("mascot.bubble") : "BAM!"} />}
    </span>
  );
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Wordmark: mascot + "cineko" + lime "tv" pill. Sizes with the font size. */
export function Logo({ className = "", mascot = true }: { className?: string; mascot?: boolean }) {
  return (
    <span className={`mt-logo inline-flex items-center font-display font-extrabold leading-none tracking-tight ${className}`}>
      {mascot && <Mascot size={0} className="mr-[0.35em] h-[1.35em] w-[1.35em]" />}
      <span>cineko</span>
      <span className="ml-[0.15em] rounded-[0.45em] bg-accent px-[0.28em] pb-[0.08em] text-on-accent">tv</span>
    </span>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-full flex-col items-center justify-center p-6 text-center">{children}</div>;
}

export const PROFILE_COLORS = ["#6366f1", "#e5a50a", "#22c55e", "#ef4444", "#06b6d4", "#d946ef", "#f97316", "#64748b"];

export type ThemeSetting = "system" | "dark" | "light";
// Designs (registry, skeletons, applyDesign) live in ./designs.
export * from "./designs";

/**
 * Applies a theme setting to <html>. "system" follows prefers-color-scheme and
 * returns a cleanup that stops listening.
 */
export function applyTheme(setting: ThemeSetting): () => void {
  const root = document.documentElement;
  const set = (light: boolean) => {
    root.classList.toggle("theme-light", light);
    root.classList.toggle("theme-dark", !light);
  };
  if (setting !== "system" || typeof window.matchMedia !== "function") {
    set(setting === "light");
    return () => {};
  }
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const onChange = () => set(mq.matches);
  onChange();
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else mq.addListener(onChange); // old TV engines
  return () => {
    if (mq.removeEventListener) mq.removeEventListener("change", onChange);
    else mq.removeListener(onChange);
  };
}

export type PosterRatingSource = "kp" | "tmdb" | "imdb" | "off";

/**
 * Picks the rating for the small poster badge: the preferred source, falling
 * back kp → tmdb (imdb → kp → tmdb). Returns null when nothing is known.
 */
export function posterRating(
  m: { rating: number | null; kp_rating?: number | null; imdb_rating?: number | null },
  source: PosterRatingSource = "kp",
): { value: number; source: "kp" | "tmdb" | "imdb" } | null {
  if (source === "off") return null;
  const order: ("kp" | "tmdb" | "imdb")[] = source === "imdb" ? ["imdb", "kp", "tmdb"] : source === "tmdb" ? ["tmdb"] : ["kp", "tmdb"];
  for (const s of order) {
    const v = s === "kp" ? m.kp_rating : s === "imdb" ? m.imdb_rating : m.rating;
    if (typeof v === "number" && v > 0) return { value: v, source: s };
  }
  return null;
}

/** Badge colour by value (Kinopoisk-style): ≥7 green, ≥5 grey, else red. */
export function ratingTone(v: number): "good" | "mid" | "bad" {
  return v >= 7 ? "good" : v >= 5 ? "mid" : "bad";
}

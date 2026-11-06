// Marty, the neon robot-cat mascot (assets copied from packages/ui/src/marty).
// Static moods are ~10–20 KB WebPs; the looping animations (~100–180 KB) are
// separate files fetched only when an animated mascot is actually rendered.
// «Конструктивизм» shows Mayakovsky instead, like the main app.
import idle from "./marty/idle.webp";
import happy from "./marty/happy.webp";
import excited from "./marty/excited.webp";
import love from "./marty/love.webp";
import music from "./marty/music.webp";
import sleepy from "./marty/sleepy.webp";
import thinking from "./marty/thinking.webp";
import surprised from "./marty/surprised.webp";
import error from "./marty/error.webp";
import loading from "./marty/loading.webp";
import popcorn from "./marty/popcorn.webp";
import laptop from "./marty/laptop.webp";
import sly from "./marty/sly.webp";
import favicon from "./marty/favicon.png";
import mayakovsky from "./marty/mayakovsky.webp";
import idleAnim from "./marty/idle-anim.webp";
import loadingAnim from "./marty/loading-anim.webp";
import sleepyAnim from "./marty/sleepy-anim.webp";
import thinkingAnim from "./marty/thinking-anim.webp";
import happyAnim from "./marty/happy-anim.webp";
import popcornAnim from "./marty/popcorn-anim.webp";
import { useSettings } from "../core/store";

export const MOODS = { idle, happy, excited, love, music, sleepy, thinking, surprised, error, loading, popcorn, laptop, sly } as const;
export type Mood = keyof typeof MOODS;
const ANIMATED: Partial<Record<Mood, string>> = { idle: idleAnim, loading: loadingAnim, sleepy: sleepyAnim, thinking: thinkingAnim, happy: happyAnim, popcorn: popcornAnim };
export const MARTY_ICON = favicon;

export function Mascot({ mood = "idle", size = 120, animated, className = "", alt = "" }: { mood?: Mood; size?: number; animated?: boolean; className?: string; alt?: string }) {
  const { design } = useSettings();
  if (design === "constructivism") {
    return (
      <span className={`mascot mascot-mk ${className}`} style={{ width: size, height: size }} aria-hidden={alt ? undefined : true}>
        <img src={mayakovsky} alt={alt} draggable={false} style={{ height: size, width: (size * 378) / 499 }} />
      </span>
    );
  }
  const src = (animated && ANIMATED[mood]) || MOODS[mood];
  return (
    <span className={`mascot ${className}`} style={{ width: size, height: size }} aria-hidden={alt ? undefined : true}>
      <img src={src} alt={alt} draggable={false} decoding="async" style={{ maxWidth: size, maxHeight: size }} />
    </span>
  );
}

/** The wordmark: Marty's icon + «cineko» + a Lite badge. */
export function Logo({ size = 34 }: { size?: number }) {
  return (
    <span className="brand">
      <img className="brand-icon" src={favicon} width={size} height={size} alt="" draggable={false} />
      <span className="brand-name">cineko</span>
      <span className="brand-sub">Lite</span>
    </span>
  );
}

export type GreetKey =
  | "greet.night1" | "greet.night2" | "greet.night3" | "greet.late1" | "greet.late2"
  | "greet.wkMorning1" | "greet.wkMorning2" | "greet.morning1" | "greet.morning2"
  | "greet.day1" | "greet.day2" | "greet.friday" | "greet.wkEvening" | "greet.evening1" | "greet.evening2"
  | "greet.newYear" | "greet.halloween";

/** One of `options`, stable for the day. */
function daily<T>(options: readonly T[], d: Date): T {
  const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
  return options[day % options.length];
}

/** Marty's line on Home by local time, weekday and a couple of dates (ported from packages/ui/src/martyMood.ts). */
export function martyMood(d: Date): { key: GreetKey; mood: Mood } {
  const h = d.getHours();
  const dow = d.getDay();
  const weekend = dow === 0 || dow === 6;
  const m = d.getMonth() + 1;
  const day = d.getDate();
  if ((m === 12 && day === 31 && h >= 18) || (m === 1 && day === 1)) return { key: "greet.newYear", mood: "excited" };
  if (m === 10 && day === 31 && (h >= 17 || h < 4)) return { key: "greet.halloween", mood: "sly" };
  if (h < 5) return daily([{ key: "greet.night1", mood: "sleepy" }, { key: "greet.night2", mood: "sleepy" }, { key: "greet.night3", mood: "music" }] as const, d);
  if (h < 12) {
    if (weekend) return daily([{ key: "greet.wkMorning1", mood: "happy" }, { key: "greet.wkMorning2", mood: "love" }] as const, d);
    return daily([{ key: "greet.morning1", mood: "happy" }, { key: "greet.morning2", mood: "laptop" }] as const, d);
  }
  if (h < 17) return daily([{ key: "greet.day1", mood: "idle" }, { key: "greet.day2", mood: "popcorn" }] as const, d);
  if (h < 23) {
    if (dow === 5) return { key: "greet.friday", mood: "popcorn" };
    if (weekend) return { key: "greet.wkEvening", mood: "popcorn" };
    return daily([{ key: "greet.evening1", mood: "happy" }, { key: "greet.evening2", mood: "love" }] as const, d);
  }
  return daily([{ key: "greet.late1", mood: "sly" }, { key: "greet.late2", mood: "popcorn" }] as const, d);
}

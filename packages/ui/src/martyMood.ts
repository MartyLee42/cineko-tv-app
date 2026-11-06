// Cineko's mood line on Home: what he says and which sticker he shows,
// by local time, weekday and a few dates. Pure: pass the date in.
import type { MascotMood } from "./marty";
import type { martyEn } from "./locales/marty.en";

export type MartyLineKey = keyof typeof martyEn;
export interface MartyMood {
  key: MartyLineKey;
  mood: MascotMood;
}

/** Picks one of `options` stably for the day (changes day to day, not on every render). */
function daily<T>(options: readonly T[], d: Date): T {
  const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
  return options[day % options.length]!;
}

export function martyMood(d: Date): MartyMood {
  const h = d.getHours();
  const dow = d.getDay(); // 0 = Sunday
  const weekend = dow === 0 || dow === 6;
  const m = d.getMonth() + 1;
  const day = d.getDate();

  if ((m === 12 && day === 31 && h >= 18) || (m === 1 && day === 1)) return { key: "marty.new_year", mood: "excited" };
  if (m === 10 && day === 31 && (h >= 17 || h < 4)) return { key: "marty.halloween", mood: "sly" };

  if (h < 5) return daily<MartyMood>([{ key: "marty.night_series", mood: "sleepy" }, { key: "marty.night_owl", mood: "sleepy" }, { key: "marty.night_quiet", mood: "music" }], d);
  if (h < 12) {
    if (weekend) return daily<MartyMood>([{ key: "marty.weekend_morning", mood: "happy" }, { key: "marty.weekend_morning2", mood: "love" }], d);
    return daily<MartyMood>([{ key: "marty.morning", mood: "happy" }, { key: "marty.morning2", mood: "laptop" }], d);
  }
  if (h < 17) return daily<MartyMood>([{ key: "marty.day", mood: "idle" }, { key: "marty.day2", mood: "popcorn" }], d);
  if (h < 23) {
    if (dow === 5) return { key: "marty.friday", mood: "popcorn" };
    if (weekend) return { key: "marty.weekend_evening", mood: "popcorn" };
    return daily<MartyMood>([{ key: "marty.evening", mood: "happy" }, { key: "marty.evening2", mood: "love" }], d);
  }
  return daily<MartyMood>([{ key: "marty.late", mood: "sly" }, { key: "marty.late_cozy", mood: "popcorn" }], d);
}

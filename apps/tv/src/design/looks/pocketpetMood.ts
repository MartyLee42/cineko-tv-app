// «Тамагочи»: how happy the pixel pet is, from the profile's watch history
// (the first page the «Для вас» screen already loads: newest first).

export interface PetProgress {
  completed: boolean;
  completed_at: string | null;
  updated_at: string;
  position_seconds: number;
}

export type PetMood = "sad" | "neutral" | "happy" | "ecstatic";

/** The window the pet remembers. */
export const PET_DAYS = 7;
const DAY = 86_400_000;
/** An unfinished title or episode counts by the minutes watched, up to one finished at 45 min. */
const PARTIAL_FULL_S = 45 * 60;
/** Score needed for 1…4 hearts. */
const HEARTS_AT = [1, 3, 6, 10];

function at(s: string | null): number {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : NaN;
}

/** Finished titles/episodes in the last week count 1 each, the rest by minutes watched. */
export function petScore(items: { progress: PetProgress }[], now: Date): number {
  const from = now.getTime() - PET_DAYS * DAY;
  let score = 0;
  for (const { progress: p } of items) {
    if (p.completed) {
      const t = at(p.completed_at);
      if ((Number.isFinite(t) ? t : at(p.updated_at)) >= from) score += 1;
    } else if (at(p.updated_at) >= from) {
      score += Math.min(1, Math.max(0, p.position_seconds) / PARTIAL_FULL_S);
    }
  }
  return Math.round(score * 10) / 10;
}

/** 0–4 hearts (the happiness meter). */
export function petHearts(score: number): number {
  let n = 0;
  for (const t of HEARTS_AT) if (score >= t) n++;
  return n;
}

export function petMood(hearts: number): PetMood {
  return hearts <= 0 ? "sad" : hearts <= 2 ? "neutral" : hearts === 3 ? "happy" : "ecstatic";
}

/** Something new was watched since the pet was last seen (it gets a popcorn). */
export function petAte(before: number | null, score: number): boolean {
  return before !== null && score >= before + 1;
}

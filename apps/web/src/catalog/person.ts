import type { Schemas } from "@martytv/contracts";

export type PersonCredit = Schemas["PersonCredit"];
export type CreditKind = "all" | "movie" | "series";
export type CreditSort = "popular" | "newest";

/** Credits of one kind, by popularity (server order) or newest first (undated last). */
export function pickCredits(credits: PersonCredit[], kind: CreditKind, sort: CreditSort): PersonCredit[] {
  const out = kind === "all" ? [...credits] : credits.filter((c) => c.media.kind === kind);
  if (sort === "newest") {
    const date = (c: PersonCredit) => c.media.release_date ?? "";
    out.sort((a, b) => (date(a) === date(b) ? 0 : !date(a) ? 1 : !date(b) ? -1 : date(a) < date(b) ? 1 : -1));
  }
  return out;
}

/** Age in whole years at `deathday` (or `now`); null without a birthday. */
export function ageOf(birthday: string | null, deathday: string | null, now = new Date()): number | null {
  if (!birthday) return null;
  const b = new Date(`${birthday}T00:00:00Z`);
  const e = deathday ? new Date(`${deathday}T00:00:00Z`) : now;
  if (Number.isNaN(b.getTime()) || Number.isNaN(e.getTime())) return null;
  let n = e.getUTCFullYear() - b.getUTCFullYear();
  if (e.getUTCMonth() < b.getUTCMonth() || (e.getUTCMonth() === b.getUTCMonth() && e.getUTCDate() < b.getUTCDate())) n--;
  return n >= 0 ? n : null;
}

/** "Keanu Reeves" → "KR" (placeholder when there's no photo). */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}

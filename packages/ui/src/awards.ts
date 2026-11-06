// Awards & nominations: pure helpers shared by the PWA and the TV app
// (MediaDetail.awards, MediaSummary.award_badge). Structurally typed (no
// contracts import), no React, no DOM.
import type { MessageKey } from "./i18n";
import { pluralForm } from "./deviceHealth";

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

export interface AwardEntryLike {
  label: string;
  year: number | null;
}

export interface AwardGroupLike {
  group: string;
  group_label: string;
  tier: number;
  wins: readonly AwardEntryLike[];
  nominations: readonly AwardEntryLike[];
}

export interface AwardBadgeLike {
  group: string;
  count: number;
}

/** Badge groups the clients translate (awards.group.<key>). */
export const AWARD_BADGE_GROUPS = ["oscar", "cannes", "venice", "berlin"] as const;

/** Localized short name of a badge group (the key itself when unknown). */
export function awardGroupName(group: string, t: T): string {
  return (AWARD_BADGE_GROUPS as readonly string[]).includes(group) ? t(`awards.group.${group}` as MessageKey) : group;
}

/** Poster badge text without the cup: «Оскар ×3», a single win just «Оскар». */
export function awardBadgeText(badge: AwardBadgeLike, t: T): string {
  const label = awardGroupName(badge.group, t);
  return badge.count > 1 ? t("awards.badge", { label, n: badge.count }) : label;
}

/** Tooltip / aria label: «Награды: Оскар ×3». */
export function awardBadgeTitle(badge: AwardBadgeLike, t: T): string {
  return t("awards.badge_title", { label: awardGroupName(badge.group, t), n: badge.count });
}

export interface AwardYearLine {
  year: number | null;
  labels: string[];
}

/** Entries per year in order of first appearance (the API sorts by year):
 * «Оскар 2020: лучший фильм, режиссёр» → { year: 2020, labels: [...] }. */
export function awardsByYear(entries: readonly AwardEntryLike[]): AwardYearLine[] {
  const out: AwardYearLine[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.year === e.year) last.labels.push(e.label);
    else out.push({ year: e.year, labels: [e.label] });
  }
  return out;
}

/** «Оскар 2020: лучший фильм, лучшая режиссёрская работа» (no year: «Оскар: …»). */
export function awardLineText(groupLabel: string, line: AwardYearLine): string {
  return `${groupLabel}${line.year != null ? ` ${line.year}` : ""}: ${line.labels.join(", ")}`;
}

/** Groups with wins first-class: the API order (tier, wins, nominations)
 * already puts them first; `other` and nomination-only groups stay last. */
export function awardWinGroups<G extends AwardGroupLike>(groups: readonly G[]): G[] {
  return groups.filter((g) => g.wins.length > 0);
}

/** Number of nominations not won, over all groups. */
export function awardNominationCount(groups: readonly AwardGroupLike[]): number {
  return groups.reduce((n, g) => n + g.nominations.length, 0);
}

/** «ещё 5 номинаций ▸» / «5 more nominations ▸». */
export function moreNominationsLabel(n: number, lang: string, t: T): string {
  return t(`awards.more_nominations_${pluralForm(lang, n)}` as MessageKey, { n });
}

/** «12 номинаций» / «12 nominations». */
export function nominationsLabel(n: number, lang: string, t: T): string {
  return t(`awards.nominations_${pluralForm(lang, n)}` as MessageKey, { n });
}

/** One-line summary of the major wins for compact places (TV details):
 * «🏆 Оскар ×3 · Канны: Золотая пальмовая ветвь». A group with one win
 * names it, several are counted; `other` (tier 3) is left out, at most
 * `max` groups. Empty string when there is no major win. */
export function awardsSummaryLine(groups: readonly AwardGroupLike[], max = 3): string {
  const parts: string[] = [];
  for (const g of groups) {
    if (g.tier >= 3 || g.wins.length === 0) continue;
    const [only] = g.wins;
    parts.push(g.wins.length === 1 && only ? `${g.group_label}: ${only.label}` : `${g.group_label} ×${g.wins.length}`);
    if (parts.length >= max) break;
  }
  return parts.length ? `🏆 ${parts.join(" · ")}` : "";
}

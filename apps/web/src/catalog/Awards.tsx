// «Награды»: awards & nominations of a title (MediaDetail.awards, from
// Wikidata) and the 🏆 poster chip (MediaSummary.award_badge).
import { useState } from "react";
import type { MediaDetail, MediaSummary } from "@martytv/contracts";
import {
  awardBadgeText,
  awardBadgeTitle,
  awardLineText,
  awardNominationCount,
  awardsByYear,
  moreNominationsLabel,
  useI18n,
} from "@martytv/ui";

/** Compact 🏆 chip on a poster (tier-1 wins only). Same look as the rating chip. */
export function AwardBadge({ badge, className = "" }: { badge: MediaSummary["award_badge"]; className?: string }) {
  const { t } = useI18n();
  if (!badge || badge.count < 1) return null;
  return (
    <span
      data-testid="award-badge"
      title={awardBadgeTitle(badge, t)}
      className={`inline-flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-semibold text-white ${className}`}
    >
      <span aria-hidden>🏆</span>
      {awardBadgeText(badge, t)}
    </span>
  );
}

/** The «Награды» section: major wins first (🏆, one line per award and
 * year), other awards muted below, nominations collapsed. */
export function Awards({ m }: { m: Pick<MediaDetail, "awards"> }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const groups = m.awards ?? [];
  if (!groups.length) return null;
  const major = groups.filter((g) => g.tier < 3 && g.wins.length > 0);
  const other = groups.filter((g) => g.tier >= 3 && g.wins.length > 0);
  const noms = groups.filter((g) => g.nominations.length > 0);
  const nomCount = awardNominationCount(groups);
  return (
    <section className="space-y-3" data-testid="awards">
      <h2 className="text-xl font-bold">{t("awards.title")}</h2>
      {major.length > 0 && (
        <ul className="space-y-1.5">
          {major.flatMap((g) =>
            awardsByYear(g.wins).map((line) => (
              <li key={`${g.group}-${line.year}`} className="flex gap-2 leading-snug" data-testid="awards-win-line">
                <span aria-hidden>🏆</span>
                <span>{awardLineText(g.group_label, line)}</span>
              </li>
            )),
          )}
        </ul>
      )}
      {other.length > 0 && (
        <ul className="space-y-1 text-sm text-muted">
          {other.flatMap((g) =>
            awardsByYear(g.wins).map((line) => (
              <li key={`${g.group}-${line.year}`} data-testid="awards-other-line">
                {awardLineText(g.group_label, line)}
              </li>
            )),
          )}
        </ul>
      )}
      {nomCount > 0 && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            data-testid="awards-more"
            className="inline-flex min-h-[36px] items-center rounded-full border border-border bg-surface px-3 text-sm font-medium transition hover:border-accent"
          >
            {open ? t("awards.hide_nominations") : moreNominationsLabel(nomCount, locale, t)}
          </button>
          {open && (
            <ul className="space-y-1 text-sm text-muted" data-testid="awards-nominations">
              {noms.flatMap((g) =>
                awardsByYear(g.nominations).map((line) => (
                  <li key={`${g.group}-${line.year}`} data-testid="awards-nomination-line">
                    {awardLineText(g.group_label, line)}
                  </li>
                )),
              )}
            </ul>
          )}
        </div>
      )}
      <p className="text-xs text-muted">{t("awards.source")}</p>
    </section>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useI18n } from "@martytv/ui";
import { Card, ErrorText, Select } from "../components";
import { CheckIcon } from "../icons";
import { useActiveProfile } from "../watch/ActiveProfile";
import { useProfileSettings, useUpdateSettings } from "../watch/queries";
import { DEFAULT_MIN_VOTES, MIN_VOTES_CHOICES, noteDirty, noteLength, noteTooLong, normalizeNote, parseMinVotes, TASTE_NOTE_MAX } from "./taste";

/**
 * Settings: «О моих вкусах» (taste_note, sent to the AI as the viewer's own
 * description) and «Минимум оценок у фильма» (min_votes). Anchor #taste.
 */
export function TasteCard() {
  const { t, locale } = useI18n();
  const { profile } = useActiveProfile();
  const q = useProfileSettings();
  const save = useUpdateSettings();
  const saved = q.data?.taste_note ?? "";
  // The unsaved draft belongs to one profile (a switch drops it).
  const [draftOf, setDraftOf] = useState<{ pid: string; text: string } | null>(null);
  const draft = draftOf && draftOf.pid === profile?.id ? draftOf.text : null;
  const setDraft = (text: string | null) => setDraftOf(text === null || !profile ? null : { pid: profile.id, text });
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setDone(false), 4000);
    return () => clearTimeout(id);
  }, [done]);
  const ready = !!q.data;
  useEffect(() => {
    // Linked from Ask AI / «Для вас» as /settings#taste (rendered once loaded).
    if (ready && window.location.hash === "#taste") document.getElementById("taste")?.scrollIntoView();
  }, [ready]);
  if (!profile || !q.data) return null;

  const text = draft ?? saved;
  const len = noteLength(text);
  const tooLong = noteTooLong(text);
  const dirty = noteDirty(saved, text);
  const minVotes = q.data.min_votes ?? DEFAULT_MIN_VOTES;
  const label = (n: number) =>
    n === 0
      ? t("taste.min_votes.0")
      : t(n === DEFAULT_MIN_VOTES ? "taste.min_votes.default" : "taste.min_votes.n", { n: n.toLocaleString(locale) });

  return (
    <Card className="space-y-5">
      <div id="taste" className="scroll-mt-20 space-y-2" data-testid="taste-card">
        <h2 className="text-lg font-bold">{t("taste.title")}</h2>
        <p className="text-xs text-muted">{t("taste.hint")}</p>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (tooLong || !dirty) return;
            save.mutate({ taste_note: normalizeNote(text) }, { onSuccess: () => (setDraft(null), setDone(true)) });
          }}
        >
          <textarea
            data-testid="taste-note"
            aria-label={t("taste.title")}
            value={text}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("taste.placeholder")}
            rows={4}
            className="w-full resize-y rounded-xl border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
          />
          <div className="flex flex-wrap items-center gap-3">
            <span data-testid="taste-counter" className={`text-xs tabular-nums ${tooLong ? "font-semibold text-danger" : "text-muted"}`}>
              {t("taste.counter", { count: len, max: TASTE_NOTE_MAX })}
              {tooLong && ` · ${t("taste.too_long", { max: TASTE_NOTE_MAX })}`}
            </span>
            <span aria-live="polite" data-testid="taste-saved" className="flex flex-1 items-center gap-1 text-sm font-semibold text-ok">
              {done && (
                <>
                  <CheckIcon /> {t("taste.saved")}
                </>
              )}
            </span>
            <button
              type="submit"
              data-testid="taste-save"
              disabled={tooLong || !dirty || save.isPending}
              className="min-h-[44px] rounded-xl bg-accent px-5 font-semibold text-on-accent disabled:opacity-50"
            >
              {t("taste.save")}
            </button>
          </div>
        </form>
      </div>
      <label className="block space-y-1.5 border-t border-border pt-4">
        <span className="font-semibold">{t("taste.min_votes")}</span>
        <span className="block text-xs text-muted">{t("taste.min_votes_hint")}</span>
        <Select
          data-testid="setting-min-votes"
          value={String(minVotes)}
          onChange={(e) => save.mutate({ min_votes: parseMinVotes(e.target.value) })}
        >
          {MIN_VOTES_CHOICES.map((n) => (
            <option key={n} value={n}>
              {label(n)}
            </option>
          ))}
        </Select>
      </label>
      <ErrorText error={save.error} />
    </Card>
  );
}

/** «Расскажите о вкусах — рекомендации станут точнее» (Ask AI, «Для вас»). */
export function TasteLink({ className = "" }: { className?: string }) {
  const { t } = useI18n();
  const q = useProfileSettings();
  const has = !!q.data?.taste_note;
  return (
    <Link to="/settings#taste" data-testid="taste-link" className={`text-sm font-medium text-muted underline-offset-2 hover:text-text hover:underline ${className}`}>
      ✍️ {has ? t("taste.cta_edit") : t("taste.cta")}
    </Link>
  );
}

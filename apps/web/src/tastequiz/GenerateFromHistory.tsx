// «✨ Заполнить по моим фильмам»: the questionnaire answers derived from the
// profile's ratings and history (server-side, deterministic). Can be pressed
// again any time to regenerate.
import { useState } from "react";
import { Link } from "react-router";
import { ApiError } from "@martytv/contracts";
import { quizGenSummary, useI18n, type MessageKey } from "@martytv/ui";
import { Button } from "../components";
import { useCatalogLang } from "../catalog/queries";
import { optionKey, useQuizApi, useQuizState, type QuizGenerated } from "./queries";

type Status = { kind: "ok" | "error"; text: string } | null;

export function GenerateFromHistory({ onDone, className = "" }: { onDone?: (r: QuizGenerated) => void; className?: string }) {
  const { t } = useI18n();
  const lang = useCatalogLang();
  const st = useQuizState();
  const quiz = useQuizApi();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const filled = Object.keys(st.data?.answers ?? {}).length > 0;

  const run = () => {
    setBusy(true);
    setStatus(null);
    quiz
      .generate(lang)
      .then(
        (r) => {
          setStatus({ kind: "ok", text: quizGenSummary(r, t) });
          onDone?.(r);
        },
        (e: unknown) => setStatus({ kind: "error", text: t(e instanceof ApiError && e.code === "not_enough_history" ? "quiz.gen.too_little" : "quiz.gen.failed") }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className={`space-y-2 ${className}`}>
      <Button data-testid="quiz-generate" data-filled={filled} busy={busy} onClick={run}>
        {busy ? t("quiz.gen.busy") : t(filled ? "quiz.gen.refresh" : "quiz.gen.fill")}
      </Button>
      {status && (
        <p data-testid="quiz-generate-status" data-status={status.kind} role="status" className={`text-sm ${status.kind === "error" ? "text-danger" : "text-text/85"}`}>
          {status.text}
        </p>
      )}
    </div>
  );
}

/** Taste page: the current questionnaire answers, with the generate button. */
export function PreferencesPanel() {
  const { t } = useI18n();
  const st = useQuizState();
  const s = st.data;
  if (!s) return null;
  const answered = (s.questions ?? []).filter((q) => (s.answers?.[q.id] ?? []).length > 0);
  return (
    <section className="space-y-4 rounded-2xl border border-accent/30 bg-gradient-to-r from-accent/10 to-surface p-4 sm:p-5" data-testid="taste-preferences">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">🎯 {t("quiz.prefs.title")}</h2>
        <Link to="/taste-quiz" className="text-sm font-semibold text-accent hover:underline">
          {t("quiz.prefs.edit")} →
        </Link>
      </div>
      {answered.length ? (
        <dl className="space-y-2.5">
          {answered.map((q) => (
            <div key={q.id} data-question={q.id}>
              <dt className="text-xs text-muted">{t(`quiz.q.${q.id}` as MessageKey)}</dt>
              <dd className="mt-1 flex flex-wrap gap-1.5">
                {(s.answers[q.id] ?? []).map((o) => (
                  <span key={o} data-option={o} className="rounded-full bg-surface-2 px-3 py-1 text-sm font-medium">
                    {t(optionKey(q.id, o))}
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-muted">{t("quiz.prefs.empty")}</p>
      )}
      <div>
        <GenerateFromHistory />
        <p className="mt-2 text-xs text-muted">{t("quiz.gen.hint")}</p>
      </div>
    </section>
  );
}

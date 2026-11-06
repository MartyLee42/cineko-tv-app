// /taste-quiz — «Давайте определим ваш вкус»: rate well-known titles (10
// stars, «Не смотрел(а)», «Хочу посмотреть», «Не хочу смотреть»), then a few
// questions, then the recommendations refresh. Answers are saved as you go.
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { MediaSummary } from "@martytv/contracts";
import { imageUrl } from "@martytv/media-types";
import { useI18n, type MessageKey } from "@martytv/ui";
import { Button, Card } from "../components";
import { useCatalogConfig, useCatalogLang } from "../catalog/queries";
import { GenerateFromHistory } from "./GenerateFromHistory";
import { optionKey, useQuizApi, useQuizState, type QuizState } from "./queries";

type Answers = Record<string, string[]>;

export function TasteQuizPage() {
  const { t } = useI18n();
  const lang = useCatalogLang();
  const { data: cfg } = useCatalogConfig();
  const st = useQuizState();
  const quiz = useQuizApi();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<"titles" | "questions" | "done">("titles");
  const [queue, setQueue] = useState<MediaSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [exhausted, setExhausted] = useState(false);
  const [rated, setRated] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [qi, setQi] = useState(0);
  const [sel, setSel] = useState<Answers | null>(null);
  const [ai, setAi] = useState(false);
  const [failed, setFailed] = useState(false);
  const asked = useRef(new Set<string>());
  const fetching = useRef(false);
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  const state: QuizState | undefined = st.data;
  const goal = state?.goal ?? 20;
  const nRated = rated ?? state?.rated ?? 0;
  const answers: Answers = sel ?? state?.answers ?? {};
  const questions = state?.questions ?? [];
  const question = questions[qi];

  useEffect(() => {
    if (phase !== "titles" || exhausted || fetching.current || queue.length > 3) return;
    fetching.current = true;
    quiz
      .titles(lang, 10)
      .then(
        (items) => {
          const fresh = items.filter((m) => !asked.current.has(m.id));
          fresh.forEach((m) => asked.current.add(m.id));
          if (fresh.length === 0) setExhausted(true);
          setQueue((q) => [...q, ...fresh]);
        },
        () => setExhausted(true),
      )
      .finally(() => {
        fetching.current = false;
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, queue.length, exhausted, lang]);

  const save = (body: Parameters<typeof quiz.answer>[0]) => {
    chain.current = chain.current.then(() => quiz.answer(body)).then(
      () => setFailed(false),
      () => setFailed(true),
    );
  };
  const current = queue[0];
  const answerTitle = (answer: "rated" | "unseen" | "want" | "not_interested", rating?: number) => {
    if (!current) return;
    save({ titles: [{ media_id: current.id, answer, ...(rating ? { rating } : {}) }] });
    const n = answer === "rated" ? nRated + 1 : nRated;
    setRated(n);
    setHover(null);
    setQueue((q) => q.slice(1));
    if (n >= goal) setPhase("questions");
  };
  const saveQuestion = () => {
    if (!question) return;
    save({ questions: { [question.id]: answers[question.id] ?? [] } });
  };
  const finish = () => {
    setPhase("done");
    void chain.current.then(() => quiz.finish(lang)).then(
      (r) => setAi(r.ai_regeneration),
      () => setFailed(true),
    );
  };
  const next = () => {
    saveQuestion();
    if (qi + 1 >= questions.length) return finish();
    setQi(qi + 1);
  };
  const toggle = (o: string) => {
    if (!question) return;
    const cur = answers[question.id] ?? [];
    const v = cur.includes(o) ? cur.filter((x) => x !== o) : question.multi ? [...cur, o] : [o];
    setSel({ ...answers, [question.id]: v });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5" data-testid="web-taste-quiz" data-phase={phase}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-extrabold sm:text-3xl">{t("quiz.title")}</h1>
        <p className="text-sm text-muted" data-testid="quiz-progress">
          {phase === "questions" ? t("quiz.question_n", { n: qi + 1, total: questions.length }) : t("quiz.rated", { n: Math.min(nRated, goal), goal })}
        </p>
      </div>
      {failed && <p className="text-sm text-danger">{t("quiz.failed")}</p>}
      {phase !== "done" && (
        <GenerateFromHistory
          onDone={() => {
            // Show the filled-in answers so they can be tweaked.
            setSel(null);
            setQi(0);
            setPhase("questions");
          }}
        />
      )}

      {phase === "titles" && (
        <Card>
          {current ? (
            <div className="flex flex-col gap-5 sm:flex-row" data-testid="quiz-title" data-media-id={current.id}>
              <img src={imageUrl(cfg, current.poster_path, "w342") ?? undefined} alt="" className="mx-auto aspect-[2/3] w-44 shrink-0 rounded-2xl bg-surface-2 object-cover sm:mx-0 sm:w-52" />
              <div className="min-w-0 flex-1 space-y-3">
                <p className="text-sm text-muted">
                  {t(current.kind === "series" ? "quiz.kind.series" : "quiz.kind.movie")}
                  {current.year ? ` · ${current.year}` : ""}
                </p>
                <h2 className="text-2xl font-bold leading-tight">{current.title}</h2>
                {current.original_title !== current.title && <p className="text-sm text-muted">{current.original_title}</p>}
                <p className="line-clamp-3 text-sm text-text/80">{current.overview}</p>
                <p className="pt-1 text-sm font-semibold">{t("quiz.rate_prompt")}</p>
                <div className="flex flex-wrap" onMouseLeave={() => setHover(null)}>
                  {Array.from({ length: 10 }, (_, i) => (
                    <button
                      key={i}
                      type="button"
                      data-star={i + 1}
                      aria-label={t("quiz.stars", { n: i + 1 })}
                      onMouseEnter={() => setHover(i)}
                      onClick={() => answerTitle("rated", i + 1)}
                      className={`h-10 w-9 text-3xl leading-none transition sm:w-10 ${hover !== null && i <= hover ? "text-accent" : "text-text/25"}`}
                    >
                      ★
                    </button>
                  ))}
                  {hover !== null && <span className="ml-2 self-center text-sm font-semibold">{t("quiz.stars", { n: hover + 1 })}</span>}
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button variant="secondary" data-action="unseen" onClick={() => answerTitle("unseen")}>
                    {t("quiz.unseen")}
                  </Button>
                  <Button variant="secondary" data-action="want" onClick={() => answerTitle("want")}>
                    {t("quiz.want")}
                  </Button>
                  <Button variant="secondary" data-action="not_interested" onClick={() => answerTitle("not_interested")}>
                    {t("quiz.not_interested")}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <p className="py-10 text-center text-muted">{loading ? t("quiz.loading") : t("quiz.no_titles")}</p>
          )}
          <div className="mt-5 flex justify-end">
            <Button variant="ghost" data-action="enough" onClick={() => setPhase("questions")}>
              {t("quiz.enough")} →
            </Button>
          </div>
        </Card>
      )}

      {phase === "questions" && question && (
        <Card className="space-y-4">
          <div data-testid="quiz-question" data-question={question.id}>
            <h2 className="text-xl font-bold">{t(`quiz.q.${question.id}` as MessageKey)}</h2>
            <p className="text-sm text-muted">{t(question.multi ? "quiz.multi_hint" : "quiz.single_hint")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {question.options.map((o) => {
              const on = (answers[question.id] ?? []).includes(o);
              return (
                <button
                  key={o}
                  type="button"
                  data-option={o}
                  aria-pressed={on}
                  onClick={() => toggle(o)}
                  className={`min-h-[44px] rounded-full border px-4 text-sm font-semibold transition ${on ? "border-accent bg-accent text-on-accent" : "border-border bg-surface-2 hover:border-accent"}`}
                >
                  {t(optionKey(question.id, o))}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap justify-between gap-2 pt-2">
            <Button variant="ghost" onClick={() => (qi === 0 ? setPhase("titles") : (saveQuestion(), setQi(qi - 1)))}>
              ← {t("quiz.prev")}
            </Button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => (qi + 1 >= questions.length ? finish() : setQi(qi + 1))}>
                {t("quiz.skip")}
              </Button>
              <Button data-action="next" onClick={next}>
                {qi + 1 >= questions.length ? t("quiz.finish") : t("quiz.next")}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {phase === "done" && (
        <Card className="space-y-4 text-center">
          <p data-testid="quiz-done" className="text-3xl font-extrabold text-accent">{t("quiz.done_title")}</p>
          <p>{ai ? t("quiz.done_text") : t("quiz.done_text_noai")}</p>
          <Button onClick={() => navigate("/")}>{t("quiz.close")}</Button>
        </Card>
      )}
    </div>
  );
}

/** Home: the invitation until the quiz is done or dismissed. */
export function QuizBanner() {
  const { t } = useI18n();
  const st = useQuizState();
  const quiz = useQuizApi();
  const [later, setLater] = useState(false);
  const s = st.data;
  if (!s || s.completed_at || s.dismissed_at || later) return null;
  return (
    <div
      data-testid="quiz-banner"
      className="flex flex-wrap items-center gap-3 rounded-3xl border border-accent/30 bg-gradient-to-r from-accent/20 via-accent/5 to-surface p-4 sm:p-5"
    >
      <span className="text-3xl">🎯</span>
      <span className="min-w-0 flex-1 font-semibold">{t("quiz.banner")}</span>
      <Link to="/taste-quiz" className="inline-flex min-h-[44px] items-center rounded-xl bg-accent px-5 font-bold text-on-accent hover:bg-accent-strong">
        {s.answered > 0 ? t("quiz.resume") : t("quiz.start")}
      </Link>
      <Button variant="ghost" onClick={() => setLater(true)}>
        {t("quiz.later")}
      </Button>
      <Button variant="ghost" onClick={() => void quiz.dismiss().catch(() => undefined)}>
        {t("quiz.never")}
      </Button>
    </div>
  );
}

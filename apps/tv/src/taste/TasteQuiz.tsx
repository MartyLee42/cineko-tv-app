// «Давайте определим ваш вкус»: the taste quiz, full screen over the catalog.
// 1) Titles: well-known films/series one by one — ◀ ▶ through 10 stars, OK
//    rates; ▼ to «Не смотрел(а)» / «Хочу посмотреть» / «Не хочу смотреть» /
//    «Хватит». 2) Questions: chips (OK toggles), Назад / Пропустить / Далее.
// 3) Done. Every answer is saved at once, so Back simply leaves.
import { useEffect, useRef, useState } from "react";
import { imageUrl, placeholderColor } from "@martytv/media-types";
import { catalogLang } from "@martytv/media-types";
import { useI18n, type MessageKey } from "@martytv/ui";
import { useCatalogConfig } from "../catalog/queries";
import { Img, legacyColor } from "../components/Img";
import { Emoji } from "../design/Emoji";
import { SkinBackground } from "../design/skins";
import { playerKey } from "../player/keys";
import { claimKeys } from "../remote/keyOwner";
import { quizApi, type MediaSummary, type QuizState } from "./data";
import { COLS, gridMove, MOOD_EMOJI, optionKey, sameSelection, STARS, TITLE_ACTIONS, toggleOption, type QuizAnswers, type TitleAction } from "./quizLogic";

type Phase = "titles" | "questions" | "done";
const Q_BUTTONS = 3; // Назад · Пропустить · Далее

export function TasteQuiz({ profileId, onClose }: { profileId: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const lang = catalogLang(locale);
  const cfg = useCatalogConfig();

  const [state, setState] = useState<QuizState | null>(null);
  const [phase, setPhase] = useState<Phase>("titles");
  const [queue, setQueue] = useState<MediaSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [exhausted, setExhausted] = useState(false);
  const [row, setRow] = useState<0 | 1>(0);
  const [star, setStar] = useState(7);
  const [act, setAct] = useState(0);
  const [rated, setRated] = useState(0);
  const [qi, setQi] = useState(0);
  const [sel, setSel] = useState<QuizAnswers>({});
  const [cell, setCell] = useState(0);
  const [aiRegen, setAiRegen] = useState(false);
  const [failed, setFailed] = useState(false);
  const asked = useRef(new Set<string>());
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  const save = (body: Parameters<typeof quizApi.answer>[1]) => {
    chain.current = chain.current
      .then(() => quizApi.answer(profileId, body))
      .then(
        (s) => (setState(s), setFailed(false)),
        () => setFailed(true),
      );
    return chain.current;
  };

  // State first (answers, rated count), then the first titles.
  useEffect(() => {
    let live = true;
    quizApi.state(profileId).then(
      (s) => {
        if (!live) return;
        setState(s);
        setRated(s.rated);
        setSel(s.answers ?? {});
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [profileId]);

  // Keep a few titles ahead.
  const fetching = useRef(false);
  useEffect(() => {
    if (phase !== "titles" || exhausted || fetching.current || queue.length > 3) return;
    fetching.current = true;
    setLoading(queue.length === 0);
    quizApi
      .titles(profileId, lang, 10)
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
  }, [phase, queue.length, exhausted, profileId, lang]);

  const questions = state?.questions ?? [];
  const goal = state?.goal ?? 20;
  const current = queue[0];
  const question = questions[qi];
  const options = question?.options ?? [];

  const toQuestions = () => {
    setPhase("questions");
    setQi(0);
    setCell(0);
  };

  const answerTitle = (a: TitleAction | "rated", rating?: number) => {
    if (a === "enough") return toQuestions();
    if (!current) return;
    void save({ titles: [{ media_id: current.id, answer: a, ...(a === "rated" ? { rating } : {}) }] });
    const n = a === "rated" ? rated + 1 : rated;
    setRated(n);
    setQueue((q) => q.slice(1));
    setRow(0);
    setStar(7);
    if (n >= goal) toQuestions();
  };

  const saveQuestion = (i: number) => {
    const q = questions[i];
    if (!q) return;
    const cur = sel[q.id] ?? [];
    if (!sameSelection(cur, state?.answers?.[q.id])) void save({ questions: { [q.id]: cur } });
  };

  const finish = () => {
    setPhase("done");
    void chain.current
      .then(() => quizApi.finish(profileId, lang))
      .then(
        (r) => setAiRegen(r.ai_regeneration),
        () => setFailed(true),
      );
  };

  const nextQuestion = () => {
    saveQuestion(qi);
    if (qi + 1 >= questions.length) return finish();
    setQi(qi + 1);
    setCell(0);
  };

  // Keys (latest closure through a ref).
  const handler = useRef<(k: string) => void>(() => undefined);
  const onKeyNow = (k: string) => {
    if (k === "back") {
      if (phase === "questions") saveQuestion(qi);
      return onClose();
    }
    if (phase === "done") {
      if (k === "ok") onClose();
      return;
    }
    if (phase === "titles") {
      if (!current) {
        if (k === "ok" && !loading) toQuestions();
        return;
      }
      if (k === "up") return setRow(0);
      if (k === "down") return setRow(1);
      if (row === 0) {
        if (k === "left") return setStar((s) => Math.max(0, s - 1));
        if (k === "right") return setStar((s) => Math.min(STARS - 1, s + 1));
        if (k === "ok") return answerTitle("rated", star + 1);
        return;
      }
      if (k === "left") return setAct((a) => Math.max(0, a - 1));
      if (k === "right") return setAct((a) => Math.min(TITLE_ACTIONS.length - 1, a + 1));
      if (k === "ok") return answerTitle(TITLE_ACTIONS[act]!);
      return;
    }
    // questions
    if (!question) return;
    if (k === "left" || k === "right" || k === "up" || k === "down") return setCell((c) => gridMove(c, options.length, COLS, Q_BUTTONS, k));
    if (k !== "ok") return;
    if (cell < options.length) {
      const opt = options[cell]!;
      setSel((s) => ({ ...s, [question.id]: toggleOption(s[question.id] ?? [], opt, question.multi) }));
      return;
    }
    const b = cell - options.length;
    if (b === 0) {
      if (qi === 0) {
        setPhase("titles");
        return;
      }
      saveQuestion(qi);
      setQi(qi - 1);
      setCell(0);
    } else if (b === 1) {
      setSel((s) => ({ ...s, [question.id]: state?.answers?.[question.id] ?? [] }));
      if (qi + 1 >= questions.length) return finish();
      setQi(qi + 1);
      setCell(0);
    } else nextQuestion();
  };

  useEffect(() => {
    handler.current = onKeyNow;
  });

  useEffect(() => {
    const c = claimKeys();
    const onKey = (e: KeyboardEvent) => {
      if (!c.top) return;
      const k = playerKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      handler.current(k);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      c.release();
    };
  }, []);

  const btn = (focused: boolean, primary = false) =>
    `tv-focus whitespace-nowrap rounded-2xl px-9 py-5 text-[28px] font-semibold ${focused ? "is-focused bg-text text-bg" : primary ? "bg-accent text-on-accent" : "bg-surface-2 text-text"}`;

  return (
    <div data-testid="taste-quiz" data-phase={phase} className="absolute left-0 top-0 z-40 h-full w-full bg-bg">
      <SkinBackground dim />
      <header className="absolute left-[120px] right-[120px] top-[64px] flex items-baseline justify-between">
        <h1 className="text-[56px] font-bold leading-tight">{t("quiz.title")}</h1>
        <p data-testid="quiz-progress" className="text-[28px] text-muted">
          {phase === "questions" ? t("quiz.question_n", { n: qi + 1, total: questions.length }) : t("quiz.rated", { n: Math.min(rated, goal), goal })}
        </p>
      </header>
      {failed && <p className="absolute left-[120px] top-[140px] text-2xl text-danger">{t("quiz.failed")}</p>}

      {phase === "titles" && (
        <div className="absolute left-[120px] right-[120px] top-[200px]">
          {current ? (
            <div data-testid="quiz-title" data-media-id={current.id} className="flex">
              <div className="relative shrink-0 overflow-hidden rounded-3xl shadow-2xl" style={{ width: 360, height: 540, background: legacyColor(placeholderColor(current.id)) }}>
                <Img src={imageUrl(cfg.data, current.poster_path, "w500")} className="absolute left-0 top-0 h-full w-full object-cover" />
              </div>
              <div className="ml-16 min-w-0 flex-1">
                <p className="text-[28px] text-muted">
                  {t(current.kind === "series" ? "quiz.kind.series" : "quiz.kind.movie")}
                  {current.year ? ` · ${current.year}` : ""}
                </p>
                <h2 className="mt-2 line-clamp-2 text-[68px] font-bold leading-[1.05]">{current.title}</h2>
                {current.original_title && current.original_title !== current.title && <p className="mt-2 truncate text-[30px] text-muted">{current.original_title}</p>}
                <p className="mt-5 line-clamp-3 max-w-[1100px] text-[26px] leading-snug text-text/80">{current.overview}</p>
                <p className="mt-9 text-[28px] text-muted">{t("quiz.rate_prompt")}</p>
                <div className="mt-4 flex items-center" data-testid="quiz-stars">
                  {Array.from({ length: STARS }, (_, i) => (
                    <span
                      key={i}
                      data-star={i + 1}
                      className={`tv-focus mr-1.5 flex h-[84px] w-[74px] items-center justify-center rounded-2xl text-[60px] leading-none ${
                        row === 0 && i === star ? "is-focused bg-surface-2" : ""
                      } ${row === 0 && i <= star ? "text-accent" : "text-text/25"}`}
                    >
                      ★
                    </span>
                  ))}
                  <span className="ml-6 text-[30px] font-semibold">{row === 0 ? t("quiz.stars", { n: star + 1 }) : ""}</span>
                </div>
                <div className="mt-8 flex gap-4" data-testid="quiz-actions">
                  {TITLE_ACTIONS.map((a, i) => (
                    <span key={a} data-action={a} className={btn(row === 1 && i === act, a === "enough")}>
                      {t(`quiz.${a}` as MessageKey)}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-40 text-center">
              <p className="text-[40px] text-muted">{loading ? t("quiz.loading") : t("quiz.no_titles")}</p>
              {!loading && (
                <div className="mt-10 flex justify-center">
                  <span className={btn(true)}>{t("quiz.next")}</span>
                </div>
              )}
            </div>
          )}
          <p className="absolute left-0 top-[800px] text-[24px] text-muted">{t("quiz.hint_titles")}</p>
        </div>
      )}

      {phase === "questions" && question && (
        <div data-testid="quiz-question" data-question={question.id} className="absolute left-[120px] right-[120px] top-[190px]">
          <h2 className="text-[60px] font-bold leading-tight">{t(`quiz.q.${question.id}` as MessageKey)}</h2>
          <p className="mt-2 text-[28px] text-muted">{t(question.multi ? "quiz.multi_hint" : "quiz.single_hint")}</p>
          <div className="mt-9 grid gap-5" style={{ gridTemplateColumns: `repeat(${COLS}, 400px)` }}>
            {options.map((o, i) => {
              const on = (sel[question.id] ?? []).includes(o);
              return (
                <span
                  key={o}
                  data-option={o}
                  data-selected={on}
                  className={`tv-focus flex h-[92px] items-center rounded-2xl px-7 text-[30px] font-semibold ${i === cell ? "is-focused" : ""} ${
                    on ? "bg-accent text-on-accent" : "bg-surface-2 text-text"
                  }`}
                >
                  {question.id === "mood" && MOOD_EMOJI[o] && (
                    <span className="mr-4 text-[36px]">
                      <Emoji e={MOOD_EMOJI[o]!} size={36} />
                    </span>
                  )}
                  <span className="truncate">{t(optionKey(question.id, o))}</span>
                  {on && <span className="ml-auto pl-3">✓</span>}
                </span>
              );
            })}
          </div>
          <div className="mt-10 flex gap-4">
            {[t("quiz.prev"), t("quiz.skip"), qi + 1 >= questions.length ? t("quiz.finish") : t("quiz.next")].map((label, b) => (
              <span key={b} data-button={["prev", "skip", "next"][b]} className={btn(cell === options.length + b, b === 2)}>
                {label}
              </span>
            ))}
          </div>
          <p className="mt-8 text-[24px] text-muted">{t("quiz.hint_questions")}</p>
        </div>
      )}

      {phase === "done" && (
        <div data-testid="quiz-done" className="absolute left-0 right-0 top-[360px] text-center">
          <p className="text-[80px] font-bold text-accent">{t("quiz.done_title")}</p>
          <p className="mt-6 text-[36px] text-text/85">{aiRegen ? t("quiz.done_text") : t("quiz.done_text_noai")}</p>
          <div className="mt-12 flex justify-center">
            <span className={btn(true)}>{t("quiz.close")}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// Home: «Давайте определим ваш вкус?» — a card at the bottom of Home until
// the profile finished or dismissed the quiz. ◀ ▶ choose, OK, Back = later.
// Test browsers (webdriver) skip it unless the URL has ?quiz=1, so other
// tests' key presses never land on it.
import { useEffect, useRef, useState } from "react";
import { useI18n, type MessageKey } from "@martytv/ui";
import { playerKey } from "../player/keys";
import { claimKeys } from "../remote/keyOwner";
import { quizApi, useQuizState } from "./data";
import { inviteDue } from "./quizLogic";

let laterThisSession = false;

function allowedHere(): boolean {
  const forced = new URLSearchParams(location.search || location.hash.split("?")[1] || "").get("quiz") === "1";
  return forced || !(typeof navigator !== "undefined" && navigator.webdriver);
}

const ACTIONS = ["start", "later", "never"] as const;

export function QuizInvite({ profileId, enabled, onStart }: { profileId: string; enabled: boolean; onStart: () => void }) {
  const { t } = useI18n();
  const q = useQuizState();
  const [later, setLater] = useState(laterThisSession);
  const [ready, setReady] = useState(false);
  const [sel, setSel] = useState(0);
  // A moment after Home appears (not over the first frame).
  useEffect(() => {
    if (!enabled) return;
    const id = setTimeout(() => setReady(true), 2500);
    return () => clearTimeout(id);
  }, [enabled]);
  const show = enabled && ready && allowedHere() && inviteDue(q.data, later);

  const act = useRef<(i: number) => void>(() => undefined);
  const actNow = (i: number) => {
    const a = ACTIONS[i];
    if (a === "start") return onStart();
    if (a === "never") void quizApi.dismiss(profileId).catch(() => undefined);
    laterThisSession = true;
    setLater(true);
  };
  const selRef = useRef(sel);
  useEffect(() => {
    act.current = actNow;
    selRef.current = sel;
  });

  useEffect(() => {
    if (!show) return;
    const c = claimKeys();
    const onKey = (e: KeyboardEvent) => {
      if (!c.top) return;
      const k = playerKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (k === "left") setSel((s) => Math.max(0, s - 1));
      else if (k === "right") setSel((s) => Math.min(ACTIONS.length - 1, s + 1));
      else if (k === "ok") act.current(selRef.current);
      else if (k === "back") act.current(1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      c.release();
    };
  }, [show]);

  if (!show) return null;
  const started = (q.data?.answered ?? 0) > 0 || Object.keys(q.data?.answers ?? {}).length > 0;
  return (
    <div data-testid="quiz-invite" className="absolute left-0 top-0 z-30 h-full w-full bg-black/45">
      <div className="absolute bottom-20 left-1/2 w-[1320px] -translate-x-1/2 rounded-[40px] bg-surface px-14 py-12 shadow-2xl">
        <h2 className="text-[54px] font-bold leading-tight">{t("quiz.title")}</h2>
        <p className="mt-3 text-[28px] leading-snug text-muted">{t("quiz.subtitle")}</p>
        <div className="mt-9 flex gap-4">
          {ACTIONS.map((a, i) => (
            <span
              key={a}
              data-action={a}
              className={`tv-focus rounded-2xl px-10 py-5 text-[30px] font-semibold ${
                i === sel ? "is-focused bg-text text-bg" : a === "start" ? "bg-accent text-on-accent" : "bg-surface-2 text-text"
              }`}
            >
              {t((a === "start" && started ? "quiz.resume" : `quiz.${a}`) as MessageKey)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

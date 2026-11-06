// «Матрица» on the web: the red / blue pill the first time this browser picks
// the design (shared logic in @martytv/ui matrix.ts), and a short intro for red.
import { useEffect, useState } from "react";
import { resolvePill, useI18n, usePillRequest } from "@martytv/ui";
import "./matrix.css";

export function PillLayer() {
  const { t } = useI18n();
  const req = usePillRequest();
  const [intro, setIntro] = useState(false);
  useEffect(() => {
    if (!intro) return;
    const id = setTimeout(() => setIntro(false), 2600);
    return () => clearTimeout(id);
  }, [intro]);
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && resolvePill("blue");
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req]);
  return (
    <>
      {req && (
        <div role="dialog" aria-modal="true" aria-labelledby="mx-pill-title" data-testid="matrix-pill" className="mx-pill-backdrop">
          <div className="mx-pill-box">
            <h2 id="mx-pill-title" className="text-2xl font-bold text-accent">
              {t("designs.matrix.pill_title")}
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-text">{t("designs.matrix.pill_text")}</p>
            <div className="mt-6 flex flex-wrap justify-center gap-4">
              <button type="button" data-pill="blue" className="mx-pill mx-pill-blue" onClick={() => resolvePill("blue")}>
                {t("designs.matrix.blue")}
              </button>
              <button
                type="button"
                data-pill="red"
                autoFocus
                className="mx-pill mx-pill-red"
                onClick={() => {
                  resolvePill("red");
                  setIntro(true);
                }}
              >
                {t("designs.matrix.red")}
              </button>
            </div>
          </div>
        </div>
      )}
      {intro && (
        <div data-testid="matrix-intro" className="mx-intro" onClick={() => setIntro(false)} aria-hidden>
          <div className="mx-intro-rain" />
          <p className="mx-intro-name">
            <span>CINEKO</span>
            <i />
          </p>
        </div>
      )}
    </>
  );
}

// «Матрица»: the first time this TV picks the design, two pills. Blue goes
// back to the previous design, red stays and plays the Matrix intro. Keys are
// captured like ActionMenu (◀▶ choose, OK takes, Back = blue).
import { useEffect, useRef, useState } from "react";
import { resolvePill, useI18n, usePillRequest } from "@martytv/ui";
import { playerKey } from "../player/keys";
import { claimKeys } from "../remote/keyOwner";

export function PillLayer({ onRed }: { onRed: () => void }) {
  const req = usePillRequest();
  if (!req) return null;
  return <PillDialog onRed={onRed} />;
}

function PillDialog({ onRed }: { onRed: () => void }) {
  const { t } = useI18n();
  // Red first: the obvious choice in a Matrix design.
  const [index, setIndex] = useState(1);
  const st = useRef({ index, onRed });
  useEffect(() => {
    st.current = { index, onRed };
  });
  useEffect(() => {
    const c = claimKeys();
    const onKey = (e: KeyboardEvent) => {
      if (!c.top) return;
      const k = playerKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const { index, onRed } = st.current;
      if (k === "left" || k === "up") setIndex(0);
      else if (k === "right" || k === "down") setIndex(1);
      else if ((k === "ok" || k === "play" || k === "playpause") && !e.repeat) {
        if (index === 1) {
          resolvePill("red");
          onRed();
        } else resolvePill("blue");
      } else if (k === "back" || k === "stop") resolvePill("blue");
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      c.release();
    };
  }, []);
  const pill = (i: number, color: string, glow: string, label: string, key: string) => (
    <div
      data-pill={key}
      className={`tv-focus flex items-center rounded-full px-14 py-7 text-4xl font-bold ${index === i ? "is-focused" : ""}`}
      style={{ background: `linear-gradient(180deg, ${glow} 0%, ${color} 55%, ${color} 100%)`, color: "#fff", boxShadow: index === i ? `0 0 0 4px #000, 0 0 0 8px ${glow}, 0 0 40px 10px ${glow}` : undefined }}
    >
      {label}
    </div>
  );
  return (
    <div data-testid="matrix-pill" className="fixed left-0 top-0 z-40 flex h-[1080px] w-[1920px] items-center justify-center bg-black/80">
      <div className="w-[1100px] bg-bg px-16 py-14 text-center" style={{ boxShadow: "inset 0 0 0 1px rgba(0,255,65,.45), 0 0 60px rgba(0,255,65,.18)" }}>
        <h2 className="text-5xl font-bold text-accent">{t("designs.matrix.pill_title")}</h2>
        <p className="mx-auto mt-6 max-w-[900px] text-3xl leading-snug text-text">{t("designs.matrix.pill_text")}</p>
        <div className="mt-12 flex items-center justify-center gap-16">
          {pill(0, "#1a3fd6", "#6f9bff", t("designs.matrix.blue"), "blue")}
          {pill(1, "#c8141e", "#ff6a6a", t("designs.matrix.red"), "red")}
        </div>
      </div>
    </div>
  );
}

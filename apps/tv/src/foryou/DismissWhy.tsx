import { useEffect, useRef, useState } from "react";
import { useI18n, type MessageKey } from "@martytv/ui";
import { playerKey } from "../player/keys";
import { claimKeys } from "../remote/keyOwner";
import { TasteNoteEditor } from "../settings/TasteNoteEditor";
import { DISLIKE_REASONS, saveNote, type NoteReason } from "./queries";

const COLS = 2;

/**
 * «Почему не интересно?» after «Не интересно» on a «Для вас» card: reason
 * chips (OK toggles), an optional comment with the on-screen keyboard, and
 * «Готово». Saved as the title's note; the title stays dismissed. Back or
 * «Готово» with nothing picked just closes.
 */
export function DismissWhy({ mediaId, title, onClose }: { mediaId: string; title: string; onClose: () => void }) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<NoteReason[]>([]);
  const [text, setText] = useState("");
  const [index, setIndex] = useState(0);
  const [typing, setTyping] = useState(false);
  // Items: the chips, then «Добавить комментарий», then «Готово».
  const n = DISLIKE_REASONS.length;
  const total = n + 2;
  const finish = () => {
    void saveNote(mediaId, text, picked);
    onClose();
  };
  const st = useRef({ index, typing, finish, onClose });
  useEffect(() => {
    st.current = { index, typing, finish, onClose };
  });
  useEffect(() => {
    const c = claimKeys();
    const onKey = (e: KeyboardEvent) => {
      if (!c.top) return;
      const k = playerKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const { index, finish, onClose } = st.current;
      const chip = index < n;
      if (k === "left") setIndex(Math.max(0, index - 1));
      else if (k === "right") setIndex(Math.min(total - 1, index + 1));
      else if (k === "down") setIndex(chip ? Math.min(index + COLS, n) : Math.min(total - 1, index + 1));
      else if (k === "up") setIndex(chip ? Math.max(0, index - COLS) : index === n ? n - COLS : index - 1);
      else if (k === "ok" && !e.repeat) {
        if (chip) {
          const r = DISLIKE_REASONS[index]!;
          setPicked((l) => (l.includes(r) ? l.filter((x) => x !== r) : [...l, r]));
        } else if (index === n) setTyping(true);
        else finish();
      } else if (k === "back") onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      c.release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (typing) {
    return (
      <TasteNoteEditor
        testId="tv-why-editor"
        title={t("taste.tv.why_text")}
        hint={title}
        max={1000}
        pausedNav={false}
        initial={text}
        onClose={() => setTyping(false)}
        onSave={(s) => {
          setText(s);
          setTyping(false);
          setIndex(total - 1);
        }}
      />
    );
  }
  const btn = (i: number, extra = "") => `tv-focus rounded-control px-8 py-4 text-3xl font-semibold ${i === index ? "is-focused" : ""} ${extra}`;
  return (
    <div data-testid="tv-dismiss-why" className="fixed left-0 top-0 z-30 flex h-[1080px] w-[1920px] items-center justify-center bg-black/60">
      <div className="w-[1100px] rounded-card bg-surface px-16 py-12 shadow-2xl">
        <h2 className="text-5xl font-bold">{t("taste.tv.why")}</h2>
        <p className="mt-2 truncate text-3xl text-muted">{title}</p>
        <p className="mt-2 text-2xl text-muted">{t("taste.tv.why_hint")}</p>
        <div className="mt-8 grid grid-cols-2 gap-4">
          {DISLIKE_REASONS.map((r, i) => {
            const on = picked.includes(r);
            return (
              <div key={r} data-reason={r} data-on={on ? "1" : "0"} className={btn(i, on ? "bg-accent text-on-accent" : "bg-surface-2")}>
                {on ? "✓ " : ""}
                {t(`taste.reason.${r}` as MessageKey)}
              </div>
            );
          })}
        </div>
        <div className="mt-6 flex items-center gap-5">
          <div data-action="comment" className={btn(n, "min-w-0 flex-1 truncate bg-surface-2")}>
            ✎ {text || t("taste.tv.why_text")}
          </div>
          <div data-action="done" className={btn(n + 1, "bg-accent text-on-accent")}>
            {t("taste.tv.why_done")}
          </div>
        </div>
      </div>
    </div>
  );
}

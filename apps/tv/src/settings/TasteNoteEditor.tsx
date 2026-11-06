import { useEffect, useRef, useState } from "react";
import { pause as pauseNav, resume as resumeNav } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n } from "@martytv/ui";
import { FocusButton, FocusSection, setFocus } from "../focus";
import { physicalKey, type KeyAction, type Layout } from "../catalog/keyboard";
import { KEYBOARD_WIDTH, ScreenKeyboard } from "../components/ScreenKeyboard";
import { playerKey } from "../player/keys";
import { claimKeys } from "../remote/keyOwner";
import { applyNoteKey, TASTE_NOTE_MAX } from "./taste";

/**
 * «О моих вкусах» on the TV: the on-screen keyboard over the settings list
 * (which pauses spatial navigation; resumed while this is open). Saving
 * hands the text back; Back cancels. Typing is easier on the phone (hint).
 */
export function TasteNoteEditor({
  initial,
  onSave,
  onClose,
  title,
  hint,
  max = TASTE_NOTE_MAX,
  pausedNav = true,
  testId = "tv-taste-editor",
}: {
  initial: string;
  onSave: (note: string) => void;
  onClose: () => void;
  title?: string;
  hint?: string;
  max?: number;
  /** Opened over a list that paused spatial navigation (Settings): resume it while open. */
  pausedNav?: boolean;
  testId?: string;
}) {
  const { t, locale } = useI18n();
  const [text, setText] = useState(initial);
  const [layout, setLayout] = useState<Layout>(locale === "ru" ? "ru" : "en");
  const edit = (a: KeyAction) => setText((p) => applyNoteKey(p, a, false, max));
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    if (pausedNav) resumeNav();
    const c = claimKeys();
    const onKey = (e: KeyboardEvent) => {
      if (!c.top) return;
      const a = physicalKey(e.key ?? "", e.ctrlKey || e.metaKey || e.altKey);
      if (a && !(a.type === "backspace" && textRef.current === "")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        // physicalKey upper-cases; keep what a real keyboard typed.
        return a.type === "char" ? setText((p) => applyNoteKey(p, { type: "char", value: e.key }, true, max)) : edit(a);
      }
      if (playerKey(e) === "back") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    void setFocus(layout === "ru" ? "tkb-А" : "tkb-A");
    return () => {
      window.removeEventListener("keydown", onKey, true);
      c.release();
      if (pausedNav) pauseNav();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = text.length > 140 ? `…${text.slice(-139)}` : text;
  return (
    <div data-testid={testId} className="fixed left-0 top-0 z-40 h-[1080px] w-[1920px] bg-bg">
      <FocusSection focusKey="taste-editor" boundary className="absolute left-[120px] top-[80px] w-[1680px]">
        <h1 className="text-[64px] font-bold">{title ?? t("taste.tv.note")}</h1>
        <p className="mt-3 text-[26px] text-muted">{hint ?? t("taste.tv.note_hint")}</p>
        <div className="mt-8 flex min-h-[150px] items-start overflow-hidden rounded-card border-2 border-border bg-surface px-7 py-5" style={{ width: 1500 }}>
          <span data-testid="tv-taste-text" className="whitespace-pre-wrap break-words text-[34px] font-semibold leading-snug">
            {shown || <span className="text-muted">{title ? t("taste.note.placeholder") : t("taste.placeholder")}</span>}
          </span>
          {shown && <span className="tv-caret ml-1 mt-2 inline-block h-10 w-1 shrink-0 bg-accent" />}
        </div>
        <p className="mt-2 text-[22px] text-muted">{t("taste.counter", { count: [...text].length, max })}</p>
        <div className="mt-6 flex">
          <div style={{ width: KEYBOARD_WIDTH }}>
            <ScreenKeyboard focusKey="tkb" layout={layout} onLayout={setLayout} onAction={edit} />
          </div>
          <FocusSection focusKey="taste-side" className="ml-16 w-[480px]">
            <FocusButton
              focusKey="taste-save"
              onPress={() => onSave(text.trim())}
              className="tv-chip mb-5 flex h-[84px] items-center justify-center rounded-control bg-accent px-8 text-[30px] font-bold text-on-accent"
            >
              {t("taste.save")}
            </FocusButton>
            <FocusButton focusKey="taste-cancel" onPress={onClose} className="tv-chip flex h-[76px] items-center justify-center rounded-control bg-surface-2 px-8 text-[26px] font-bold">
              {t("common.cancel")}
            </FocusButton>
          </FocusSection>
        </div>
      </FocusSection>
    </div>
  );
}

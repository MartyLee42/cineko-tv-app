import { useState } from "react";
import { useI18n } from "@martytv/ui";
import { ErrorText } from "../components";
import { CheckIcon } from "../icons";
import { useSaveNote } from "./queries";
import { NOTE_MAX, noteBody, reasonChips, reasonKey, toggleReason, type MediaNote, type NoteReason, type ReasonSide } from "./notes";

/**
 * Reason chips + optional text for a title («Почему?», «Моя заметка»).
 * Saving replaces the profile's note; empty deletes it.
 */
export function NoteEditor({
  mediaId,
  initial,
  side = "all",
  autoFocus,
  onSaved,
  testId = "note-editor",
}: {
  mediaId: string;
  initial?: MediaNote | null;
  side?: ReasonSide;
  autoFocus?: boolean;
  onSaved?: () => void;
  testId?: string;
}) {
  const { t } = useI18n();
  const save = useSaveNote();
  const [reasons, setReasons] = useState<NoteReason[]>(initial?.reasons ?? []);
  const [text, setText] = useState(initial?.text ?? "");
  const [done, setDone] = useState(false);
  const chips = reasonChips(side, reasons);
  const len = [...text.trim()].length;
  const heading = side === "dislike" ? t("taste.reasons.dislike") : side === "like" ? t("taste.reasons.like") : null;
  return (
    <form
      data-testid={testId}
      className="space-y-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (len > NOTE_MAX) return;
        save.mutate({ mediaId, ...noteBody(text, reasons) }, { onSuccess: () => (setDone(true), onSaved?.()) });
      }}
    >
      {heading && <p className="text-xs font-semibold uppercase tracking-wide text-muted">{heading}</p>}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("taste.why")}>
        {chips.map((r) => {
          const on = reasons.includes(r);
          return (
            <button
              key={r}
              type="button"
              data-reason={r}
              aria-pressed={on}
              onClick={() => (setDone(false), setReasons((l) => toggleReason(l, r)))}
              className={`min-h-[34px] rounded-full border px-3 text-sm transition ${on ? "border-accent bg-accent/15 font-semibold text-text" : "border-border text-muted hover:border-muted hover:text-text"}`}
            >
              {t(reasonKey(r))}
            </button>
          );
        })}
      </div>
      <textarea
        data-testid="note-text"
        aria-label={t("taste.note.title")}
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => (setDone(false), setText(e.target.value))}
        placeholder={t("taste.note.placeholder")}
        rows={2}
        className="w-full resize-y rounded-xl border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
      />
      <div className="flex items-center gap-3">
        <span className={`text-xs tabular-nums ${len > NOTE_MAX ? "font-semibold text-danger" : "text-muted"}`}>{t("taste.note.counter", { count: len })}</span>
        <span aria-live="polite" data-testid="note-saved" className="flex flex-1 items-center gap-1 text-sm font-semibold text-ok">
          {done && (
            <>
              <CheckIcon /> {t("taste.note.saved")}
            </>
          )}
        </span>
        <button
          type="submit"
          data-testid="note-save"
          disabled={save.isPending || len > NOTE_MAX}
          className="min-h-[38px] rounded-xl bg-accent px-4 text-sm font-semibold text-on-accent disabled:opacity-50"
        >
          {t("taste.note.save")}
        </button>
      </div>
      <ErrorText error={save.error} />
    </form>
  );
}

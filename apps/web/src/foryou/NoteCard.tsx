import { useState } from "react";
import type { MediaSummary } from "@martytv/contracts";
import { useI18n } from "@martytv/ui";
import { Card } from "../components";
import { ShieldIcon } from "../icons";
import { NoteEditor } from "./NoteEditor";
import { noteEmpty, reasonKey, sideForRating } from "./notes";

/** Title page: «Моя заметка» — the active profile's private note, view and edit. */
export function NoteCard({ m }: { m: MediaSummary }) {
  const { t } = useI18n();
  const note = m.me?.note ?? null;
  const [editing, setEditing] = useState(false);
  if (!m.me) return null; // no active profile
  const empty = noteEmpty(note);
  return (
    <Card className="space-y-3">
      <div data-testid="note-card" className="space-y-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="font-bold">{t("taste.note.title")}</h2>
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <ShieldIcon className="shrink-0" /> {t("taste.note.private")}
            </p>
          </div>
          {!editing && (
            <button
              type="button"
              data-testid="note-edit"
              onClick={() => setEditing(true)}
              className="min-h-[38px] shrink-0 rounded-xl bg-surface-2 px-3.5 text-sm font-semibold hover:bg-border"
            >
              {empty ? t("taste.note.add") : t("taste.note.edit")}
            </button>
          )}
        </div>
        {editing ? (
          <NoteEditor mediaId={m.id} initial={note} side={sideForRating(m.me.rating)} autoFocus onSaved={() => setEditing(false)} />
        ) : (
          !empty && (
            <div data-testid="note-view" className="space-y-2">
              {note!.reasons.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {note!.reasons.map((r) => (
                    <span key={r} data-reason={r} className="rounded-full bg-accent/15 px-2.5 py-1 text-xs font-semibold">
                      {t(reasonKey(r))}
                    </span>
                  ))}
                </div>
              )}
              {note!.text && <p className="whitespace-pre-line text-sm">{note!.text}</p>}
            </div>
          )
        )}
      </div>
    </Card>
  );
}

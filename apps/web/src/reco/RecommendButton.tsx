import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { MediaSummary } from "@martytv/contracts";
import { placeholderColor } from "@martytv/media-types";
import { ProfileAvatar, Spinner, useI18n } from "@martytv/ui";
import { Button, ErrorText } from "../components";
import { CheckIcon, CloseIcon } from "../icons";
import { Sheet } from "../remote/SendToTv";
import { RecoIcon } from "./icons";
import { joinNames, personName, toggleId } from "./logic";
import { useDirectory, useRecommend } from "./queries";

const MAX_NOTE = 500;

/** «Посоветовать» on the title page: pick people, add a note, send. */
export function RecommendButton({ m, className = "" }: { m: Pick<MediaSummary, "id" | "title">; className?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        data-testid="recommend-button"
        onClick={() => setOpen(true)}
        className={`inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-border bg-surface/70 px-3.5 text-sm font-semibold backdrop-blur transition hover:border-accent ${className}`}
      >
        <RecoIcon className="text-lg" />
        {t("reco.recommend")}
      </button>
      {open &&
        createPortal(
          <RecommendSheet
            m={m}
            onClose={() => setOpen(false)}
            onSent={(names) => {
              setOpen(false);
              setSentTo(names);
            }}
          />,
          document.body,
        )}
      {sentTo && createPortal(<SentToast names={sentTo} onDismiss={() => setSentTo(null)} />, document.body)}
    </>
  );
}

function RecommendSheet({
  m,
  onClose,
  onSent,
}: {
  m: Pick<MediaSummary, "id" | "title">;
  onClose: () => void;
  onSent: (names: string) => void;
}) {
  const { t, locale } = useI18n();
  const people = useDirectory();
  const send = useRecommend();
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState("");

  const submit = () => {
    if (!picked.length) return;
    const names = picked.map((id) => people.data?.find((u) => u.id === id)).filter(Boolean).map((u) => personName(u!));
    send.mutate(
      { media_id: m.id, to_user_ids: picked, ...(note.trim() && { note: note.trim() }) },
      { onSuccess: () => onSent(joinNames(names, locale)) },
    );
  };

  return (
    <Sheet title={t("reco.recommend_to")} subtitle={m.title} onClose={onClose} testId="recommend-sheet">
      <div className="space-y-4 pt-1">
        <div>
          <p className="mb-2 text-sm font-medium text-muted">{t("reco.pick")}</p>
          {people.isPending ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : people.error ? (
            <ErrorText error={people.error} />
          ) : !people.data.length ? (
            <p className="rounded-xl bg-surface-2 px-3 py-4 text-center text-sm text-muted">{t("reco.no_people")}</p>
          ) : (
            <ul className="flex flex-wrap gap-2" aria-label={t("reco.pick")}>
              {people.data.map((u) => {
                const on = picked.includes(u.id);
                const name = personName(u);
                return (
                  <li key={u.id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      data-testid="reco-person"
                      onClick={() => setPicked((p) => toggleId(p, u.id))}
                      className={`flex min-h-[44px] items-center gap-2 rounded-full border py-1 pl-1 pr-3.5 text-sm font-medium transition ${
                        on ? "border-accent bg-accent/15 text-text" : "border-border bg-surface-2 text-text/90 hover:border-muted"
                      }`}
                    >
                      <span className="relative">
                        <ProfileAvatar name={name} color={placeholderColor(u.id)} size={32} className="!rounded-full" />
                        {on && (
                          <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[10px] text-on-accent ring-2 ring-surface">
                            <CheckIcon />
                          </span>
                        )}
                      </span>
                      <span className="max-w-[10rem] truncate">{name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <label className="block space-y-1.5">
          <span className="sr-only">{t("reco.note_label")}</span>
          <textarea
            value={note}
            maxLength={MAX_NOTE}
            rows={3}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("reco.note_placeholder")}
            data-testid="reco-note"
            className="w-full resize-none rounded-xl border border-border bg-bg px-3 py-2.5 text-text outline-none focus:border-accent"
          />
          {note.length > MAX_NOTE - 100 && (
            <span className="block text-right text-xs text-muted">
              {note.length}/{MAX_NOTE}
            </span>
          )}
        </label>
        <ErrorText error={send.error} />
        <Button className="w-full" disabled={!picked.length} busy={send.isPending} onClick={submit} data-testid="reco-send">
          <RecoIcon className="text-lg" />
          {t("reco.recommend")}
        </Button>
      </div>
    </Sheet>
  );
}

function SentToast({ names, onDismiss }: { names: string; onDismiss: () => void }) {
  const { t } = useI18n();
  useEffect(() => {
    const id = setTimeout(onDismiss, 5000);
    return () => clearTimeout(id);
  }, [onDismiss]);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-30 flex justify-center px-3 md:bottom-6">
      <div
        role="status"
        data-testid="reco-sent-toast"
        className="pointer-events-auto flex min-h-[60px] w-full max-w-md items-center gap-3 rounded-2xl border border-ok/30 bg-surface/95 py-2 pl-3.5 pr-2 shadow-2xl shadow-black/50 backdrop-blur"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ok/15 text-lg text-ok">
          <CheckIcon />
        </span>
        <p className="min-w-0 flex-1 py-1.5 text-sm font-medium">{t("reco.sent", { names })}</p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("common.close")}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted hover:text-text"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

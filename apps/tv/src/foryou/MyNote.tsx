import type { Schemas } from "@martytv/contracts";
import { useI18n, type MessageKey } from "@martytv/ui";
import type { Design } from "../design/context";

/** Details: the profile's private note («Моя заметка»), read-only (edited on the phone/web). */
export function MyNote({ note, design }: { note: Schemas["MediaNote"]; design: Design }) {
  const { t } = useI18n();
  const box = design === "terminal" ? "border-l-4 border-accent bg-surface/90" : design === "projector" ? "tv-panel rounded-[28px]" : "rounded-[22px] bg-surface/90";
  return (
    <div data-testid="my-note" className={`px-8 py-7 ${box}`}>
      <p className={design === "terminal" ? "t-label text-[17px] text-accent" : "text-[20px] text-muted"}>📝 {t("taste.note.title")}</p>
      {note.reasons.length > 0 && (
        <p className="mt-2 line-clamp-2 text-[22px] font-semibold text-text">{note.reasons.map((r) => t(`taste.reason.${r}` as MessageKey)).join(" · ")}</p>
      )}
      {note.text && <p className="mt-2 line-clamp-4 text-[26px] leading-snug text-text">«{note.text}»</p>}
    </div>
  );
}

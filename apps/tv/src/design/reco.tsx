// «Советуют близкие»: sender chips on cards and the note card in Details.
import { useI18n } from "@martytv/ui";
import { legacyColor } from "../components/Img";
import { usePlural, type Design } from "./context";
import { daysAgo, indexTag, initial } from "./format";
import type { Recommendation } from "./data";

export function useAgo() {
  const { t } = useI18n();
  const plural = usePlural();
  return (iso: string) => {
    const n = daysAgo(iso, new Date());
    return n === 0 ? t("tvd.ago.today") : n === 1 ? t("tvd.ago.yesterday") : plural("tvd.ago.days", n);
  };
}

function Avatar({ r, size }: { r: Recommendation; size: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{ width: size, height: size, fontSize: size * 0.5, background: legacyColor(r.from.color || "#64748b") }}
    >
      {r.from.avatar || initial(r.from.name)}
    </span>
  );
}

/** Sender chip in a card's top-left corner (Терминал: "01 · МАМА" tag). */
export function SenderChip({ r, design, index }: { r: Recommendation; design: Design; index: number }) {
  const unseen = !r.seen_at;
  if (design === "terminal") {
    return (
      <span data-reco-from={r.from.name} className={`t-tag t-label absolute left-0 top-0 max-w-full truncate px-2 py-0.5 font-mono text-[16px] ${unseen ? "text-accent" : "text-text/80"}`}>
        {indexTag(index)} · {r.from.name}
      </span>
    );
  }
  return (
    <span data-reco-from={r.from.name} className="absolute left-2 top-2 flex max-w-[85%] items-center rounded-full bg-black/70 py-[3px] pl-[3px] pr-3 text-[18px] text-white">
      <Avatar r={r} size={26} />
      <span className="ml-2 truncate">{r.from.name}</span>
    </span>
  );
}

/** Details: "Лёша советует · 3 дня назад" + the note (PDF p5, right). */
export function RecoNote({ r, design }: { r: Recommendation; design: Design }) {
  const { t } = useI18n();
  const ago = useAgo();
  const box = design === "terminal" ? "border-l-4 border-accent bg-surface/90" : design === "projector" ? "tv-panel rounded-[28px]" : "rounded-[22px] bg-surface/90";
  return (
    <div data-testid="reco-note" className={`flex px-8 py-7 ${box}`}>
      {design !== "terminal" && (
        <span className="mr-6">
          <Avatar r={r} size={52} />
        </span>
      )}
      <div className="min-w-0">
        <p className={design === "terminal" ? "t-label text-[17px] text-accent" : "text-[20px] text-muted"}>
          {t("reco.from", { name: r.from.name })} · {ago(r.created_at)}
        </p>
        {r.note && <p className="mt-2 line-clamp-4 text-[26px] leading-snug text-text">«{r.note}»</p>}
      </div>
    </div>
  );
}

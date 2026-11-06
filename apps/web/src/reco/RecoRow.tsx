import { useRef } from "react";
import { Link, useNavigate } from "react-router";
import type { Recommendation } from "@martytv/contracts";
import { ProfileAvatar, useI18n } from "@martytv/ui";
import { Poster } from "../catalog/components";
import { ChevronLeft, ChevronRight } from "../icons";
import { rowItems } from "./logic";
import { useRecoInbox, useUpdateReco } from "./queries";

const rowItem = "w-[7.25rem] shrink-0 snap-start sm:w-36 lg:w-40";

/** Home: «Советуют близкие» — shown only when someone recommended something. */
export function RecoRow() {
  const { t } = useI18n();
  const q = useRecoInbox();
  const scroller = useRef<HTMLDivElement>(null);
  const items = rowItems(q.data?.items ?? []);
  if (!items.length) return null;
  const unseen = q.data?.unseen ?? 0;
  const scroll = (dir: 1 | -1) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.85, behavior: "smooth" });
  return (
    <section className="group/row" data-testid="row-reco">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="flex items-baseline gap-2.5 text-lg font-bold sm:text-xl">
          {t("reco.row")}
          {unseen > 0 && (
            <span data-testid="reco-row-new" className="rounded-full bg-accent px-2 py-0.5 text-xs font-bold text-on-accent">
              {t("reco.new", { n: unseen })}
            </span>
          )}
        </h2>
        <Link to="/recommendations" className="shrink-0 py-2 text-sm font-medium text-muted hover:text-accent">
          {t("catalog.see_all")} →
        </Link>
      </div>
      <div className="relative">
        <div
          ref={scroller}
          className="no-scrollbar -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 sm:gap-4 md:mx-0 md:scroll-px-0 md:px-0"
        >
          {items.map((r) => (
            <RecoCard key={r.id} r={r} />
          ))}
        </div>
        {items.length > 4 && (
          <>
            <Arrow dir={-1} onClick={() => scroll(-1)} label={t("catalog.scroll_left")} />
            <Arrow dir={1} onClick={() => scroll(1)} label={t("catalog.scroll_right")} />
          </>
        )}
      </div>
    </section>
  );
}

function RecoCard({ r }: { r: Recommendation }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const update = useUpdateReco();
  const open = () => {
    if (!r.seen_at) update.mutate({ id: r.id, patch: { seen: true } });
    navigate(`/title/${r.media.id}`);
  };
  return (
    <button type="button" onClick={open} className={`group block text-left outline-none ${rowItem}`} data-testid="reco-row-card">
      <div className="relative rounded-xl transition duration-200 group-hover:-translate-y-0.5 group-focus-visible:ring-2 group-focus-visible:ring-accent">
        <Poster item={r.media} className="shadow-lg shadow-black/30 ring-1 ring-black/5" />
        {!r.seen_at && <span className="absolute right-1.5 top-1.5 h-3 w-3 rounded-full bg-accent ring-2 ring-black/30" aria-hidden />}
        <ProfileAvatar
          name={r.from.name}
          color={r.from.color}
          avatar={r.from.avatar}
          size={30}
          className="!absolute bottom-1.5 left-1.5 !rounded-full shadow-md ring-2 ring-black/40"
        />
      </div>
      <p className="mt-2 line-clamp-2 text-sm font-medium leading-snug group-hover:text-accent-strong">{r.media.title}</p>
      <p className="mt-0.5 truncate text-xs text-muted" title={t("reco.from", { name: r.from.name })}>
        {r.from.name}
      </p>
      {r.note && <p className="mt-0.5 line-clamp-2 text-xs italic text-text/80">“{r.note}”</p>}
    </button>
  );
}

function Arrow({ dir, onClick, label }: { dir: 1 | -1; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      tabIndex={-1}
      className={`absolute top-[calc(50%-2.5rem)] z-[1] hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-bg/85 text-xl text-text opacity-0 shadow-xl backdrop-blur transition hover:bg-surface-2 group-hover/row:opacity-100 md:flex ${
        dir < 0 ? "-left-3" : "-right-3"
      }`}
    >
      {dir < 0 ? <ChevronLeft /> : <ChevronRight />}
    </button>
  );
}

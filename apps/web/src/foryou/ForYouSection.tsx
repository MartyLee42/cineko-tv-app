import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { reasonText, rowTitle, visibleRows, useI18n, type MessageKey } from "@martytv/ui";
import { MeBadges, Poster, RatingBadge } from "../catalog/components";
import { AwardBadge } from "../catalog/Awards";
import { ChevronLeft, ChevronRight, CloseIcon, EyeIcon } from "../icons";
import { useActiveProfile } from "../watch/ActiveProfile";
import { TasteLink } from "./TasteCard";
import { RegenButton } from "./RegenButton";
import { NoteEditor } from "./NoteEditor";
import { trackOpen, useDismiss, useFeedback, useForYouRows, type ForYouItem, type ForYouRow } from "./queries";
import { FamilyCardExtra, FamilyRowHeader } from "../family/Family";
import { QuickSheet, useQuickSheet } from "../watch/QuickActions";

const rowItem = "w-[7.25rem] shrink-0 snap-start sm:w-36 lg:w-40";
const LONG_PRESS_MS = 500;

/**
 * Home: «Для вас» — reason-titled rows of personal recommendations. Cards show
 * their reason on hover / long-press, with «Не интересно».
 */
export function ForYouSection() {
  const { t } = useI18n();
  const q = useForYouRows();
  const dismiss = useDismiss();
  const [undo, setUndo] = useState<{ id: string; title: string; row: string; why?: boolean } | null>(null);
  // The toast hides after 6 s unless «Почему?» was opened.
  useEffect(() => {
    if (!undo || undo.why) return;
    const id = setTimeout(() => setUndo(null), 6000);
    return () => clearTimeout(id);
  }, [undo]);

  if (!q.data) {
    if (!q.isPending) return null;
    return (
      <section aria-hidden>
        <div className="mb-3 h-6 w-40 animate-pulse rounded bg-surface-2" />
        <div className="flex gap-3 overflow-hidden sm:gap-4">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className={`${rowItem} aspect-[2/3] animate-pulse rounded-xl bg-surface-2`} />
          ))}
        </div>
      </section>
    );
  }
  const rows = visibleRows(q.data.rows, q.data.cold_start);
  const onDismiss = (it: ForYouItem, row: ForYouRow) => {
    dismiss.mutate({ mediaId: it.media.id, rowId: row.id });
    setUndo({ id: it.media.id, title: it.media.title, row: row.id });
  };

  return (
    <section data-testid="foryou" className="space-y-7 sm:space-y-9" aria-labelledby="foryou-title">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="foryou-title" className="flex items-center gap-2.5 text-xl font-extrabold sm:text-2xl">
          <span className="inline-block h-6 w-1.5 rounded-full bg-accent" aria-hidden />
          {t("fy.section")}
          {q.data.stale && (
            <span data-testid="foryou-stale" className="text-xs font-medium text-muted">
              {t("fy.stale")}
            </span>
          )}
        </h2>
        <div className="order-last flex basis-full flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <TasteLink className="pt-2" />
          <RegenButton />
        </div>
        <div className="flex gap-2 text-sm font-semibold">
          <Link to="/surprise" data-testid="foryou-surprise" className="flex min-h-[40px] items-center gap-1.5 rounded-full bg-accent/15 px-3.5 text-text hover:bg-accent/25">
            🎲 {t("nav.surprise")}
          </Link>
          <Link to="/ask" data-testid="foryou-ask" className="flex min-h-[40px] items-center gap-1.5 rounded-full bg-accent/15 px-3.5 text-text hover:bg-accent/25">
            ✨ {t("ask.card.title")}
          </Link>
          <Link to="/explore" className="flex min-h-[40px] items-center rounded-full bg-surface-2 px-3.5 hover:bg-border">
            {t("nav.explore")}
          </Link>
        </div>
      </div>
      {q.data.cold_start && (
        <div data-testid="foryou-cold" className="flex flex-col gap-3 rounded-2xl border border-dashed border-border bg-surface p-4 sm:flex-row sm:items-center">
          <p className="flex-1 text-sm text-muted">{t("fy.cold_start")}</p>
          <Link to="/history" className="inline-flex min-h-[40px] shrink-0 items-center justify-center rounded-xl bg-surface-2 px-4 text-sm font-semibold hover:bg-border">
            {t("fy.cold_start_cta")}
          </Link>
        </div>
      )}
      {rows.map((row) => (
        <ForYouRowView key={row.id} row={row} onDismiss={(it) => onDismiss(it, row)} />
      ))}
      {undo && (
        <div
          role="status"
          data-testid="foryou-undo"
          className="fixed inset-x-4 bottom-[calc(76px+env(safe-area-inset-bottom))] z-30 mx-auto max-w-md space-y-3 rounded-2xl border border-border bg-surface px-4 py-3 text-sm shadow-2xl shadow-black/40 md:bottom-6"
        >
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1">{t("fy.dismissed", { title: undo.title })}</span>
            {!undo.why && (
              <button
                type="button"
                data-testid="foryou-dismiss-why"
                className="shrink-0 rounded-lg px-2 py-1 font-semibold text-accent-strong underline hover:bg-surface-2"
                onClick={() => setUndo({ ...undo, why: true })}
              >
                {t("taste.why")}
              </button>
            )}
            <button
              type="button"
              className="shrink-0 rounded-lg px-2 py-1 font-semibold underline hover:bg-surface-2"
              onClick={() => {
                dismiss.mutate({ mediaId: undo.id, rowId: undo.row, undo: true });
                setUndo(null);
              }}
            >
              {t("fy.undo")}
            </button>
            {undo.why && (
              <button type="button" aria-label={t("common.close")} className="shrink-0 rounded-lg p-1 text-muted hover:bg-surface-2" onClick={() => setUndo(null)}>
                <CloseIcon />
              </button>
            )}
          </div>
          {undo.why && (
            <div className="border-t border-border pt-3">
              <p className="mb-2 text-xs text-muted">{t("taste.why_hint")}</p>
              {/* Saved as the title's note; it stays dismissed. */}
              <NoteEditor mediaId={undo.id} side="dislike" testId="foryou-dismiss-note" onSaved={() => setTimeout(() => setUndo(null), 1200)} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ForYouRowView({ row, onDismiss }: { row: ForYouRow; onDismiss: (it: ForYouItem) => void }) {
  const { t } = useI18n();
  const feedback = useFeedback();
  const ref = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const title = rowTitle(row, t);
  const ids = row.items.map((i) => i.media.id).join(",");

  // One impression batch per row once it scrolls into view.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        io.disconnect();
        for (const id of ids.split(",")) if (id) feedback(id, "impression", row.id);
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, row.id]);

  const update = () => {
    const el = scroller.current;
    if (el) setEdges({ start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 8 });
  };
  useEffect(update, [ids]);
  const scroll = (dir: 1 | -1) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.85, behavior: "smooth" });

  const href = row.kind === "ai_collection" && row.reason.collection_id ? `/collections/${row.reason.collection_id}` : null;
  // «Семья советует»: member match chips under the title, avatars + the "why" on cards.
  const family = row.kind === "family";
  const curated = row.kind === "curated" ? row.curated : undefined;
  return (
    <section ref={ref} className="group/row" data-testid={`foryou-row-${row.kind}`} data-row-id={row.id}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h3 className="min-w-0 truncate text-lg font-bold sm:text-xl" title={title}>
            {title}
          </h3>
          {family && <FamilyRowHeader row={row} />}
        </div>
        {href && (
          <Link to={href} className="shrink-0 py-2 text-sm font-medium text-muted hover:text-accent">
            {t("catalog.see_all")} →
          </Link>
        )}
        {curated && (
          <Link to={`/curated/${encodeURIComponent(curated.list_id)}`} data-testid="curated-row-link" className="shrink-0 py-2 text-sm font-medium text-muted hover:text-accent">
            {t("curated.open_all")}
          </Link>
        )}
      </div>
      <div className="relative">
        <div
          ref={scroller}
          onScroll={update}
          className="no-scrollbar -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 sm:gap-4 md:mx-0 md:scroll-px-0 md:px-0"
        >
          {row.items.map((it) =>
            family ? (
              <div key={it.media.id} className={`relative ${rowItem}`}>
                <ForYouCard item={it} rowId={row.id} onDismiss={() => onDismiss(it)} />
                <FamilyCardExtra item={it} />
              </div>
            ) : (
              <ForYouCard key={it.media.id} item={it} rowId={row.id} onDismiss={() => onDismiss(it)} className={rowItem} />
            ),
          )}
        </div>
        <Arrow dir={-1} hidden={edges.start} onClick={() => scroll(-1)} label={t("catalog.scroll_left")} />
        <Arrow dir={1} hidden={edges.end} onClick={() => scroll(1)} label={t("catalog.scroll_right")} />
      </div>
    </section>
  );
}

/** A recommendation card: poster, title, and the reason + «Не интересно» on hover / long-press. */
export function ForYouCard({ item, rowId, onDismiss, className = "" }: { item: ForYouItem; rowId: string; onDismiss: () => void; className?: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { profileId } = useActiveProfile();
  const m = item.media;
  const why = reasonText(item.reason, t);
  const [open, setOpen] = useState(false);
  const quick = useQuickSheet();
  const card = useRef<HTMLDivElement>(null);
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; long: boolean }>({ long: false });
  useEffect(() => () => clearTimeout(press.current.timer), []);

  const go = () => {
    trackOpen(profileId, m.id, rowId);
    navigate(`/title/${m.id}`);
  };

  return (
    <div ref={card} className={`group relative ${className}`} data-testid="foryou-card" data-media-id={m.id}>
      <a
        href={`/title/${m.id}`}
        onClick={(e) => {
          e.preventDefault();
          // The tap that ended a long press only opens the overlay.
          if (press.current.long) {
            press.current.long = false;
            return;
          }
          go();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
        onTouchStart={() => {
          press.current.long = false;
          clearTimeout(press.current.timer);
          press.current.timer = setTimeout(() => {
            press.current.long = true;
            setOpen(true);
          }, LONG_PRESS_MS);
        }}
        onTouchEnd={() => clearTimeout(press.current.timer)}
        onTouchMove={() => clearTimeout(press.current.timer)}
        className="block select-none outline-none [-webkit-touch-callout:none]"
        title={why}
      >
        <div className="relative overflow-hidden rounded-xl transition duration-200 group-hover:-translate-y-0.5 group-focus-within:ring-2 group-focus-within:ring-accent">
          <Poster item={m} className="shadow-lg shadow-black/30 ring-1 ring-black/5" />
          <div className="absolute left-1.5 top-1.5 flex flex-col items-start gap-1">
            <RatingBadge rating={m.kp_rating ?? m.rating} />
            <AwardBadge badge={m.award_badge} />
          </div>
          <MeBadges me={m.me} />
          {/* Desktop hover: the reason slides up over the poster. */}
          <div
            data-testid="foryou-reason-hover"
            className="pointer-events-none absolute inset-x-0 bottom-0 hidden translate-y-2 bg-gradient-to-t from-black/90 via-black/75 to-transparent px-2.5 pb-2.5 pt-8 text-xs font-medium leading-snug text-white opacity-0 transition duration-200 group-hover:translate-y-0 group-hover:opacity-100 [@media(hover:hover)]:block"
          >
            <span className="line-clamp-4">{why}</span>
          </div>
        </div>
        <p className="mt-2 line-clamp-2 text-sm font-medium leading-snug group-hover:text-accent-strong">{m.title}</p>
        <p className="mt-0.5 text-xs text-muted">{[m.year, t(`catalog.kind.${m.kind}` as MessageKey)].filter(Boolean).join(" · ")}</p>
      </a>
      {/* Desktop hover: «Не интересно» in the corner (keyboard reachable too). */}
      <button
        type="button"
        aria-label={`${t("fy.dismiss")}: ${m.title}`}
        title={t("fy.dismiss")}
        data-testid="foryou-dismiss-quick"
        onClick={onDismiss}
        className="absolute right-1.5 top-1.5 z-[1] hidden h-8 w-8 items-center justify-center rounded-full bg-black/70 text-base text-white opacity-0 shadow-md transition hover:bg-danger focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:flex"
      >
        <CloseIcon />
      </button>
      {/* Touch: a small "why" button; long-press does the same. */}
      <button
        type="button"
        aria-label={t("fy.why")}
        data-testid="foryou-why"
        onClick={() => setOpen(true)}
        className="absolute right-1.5 top-1.5 z-[1] flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-[15px] text-white shadow-md [@media(hover:hover)]:hidden"
      >
        <EyeIcon />
      </button>
      {open && (
        <div
          data-testid="foryou-overlay"
          className="absolute inset-x-0 top-0 z-[2] flex aspect-[2/3] flex-col justify-end rounded-xl bg-black/85 p-2.5 text-white shadow-xl"
          onClick={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <button type="button" aria-label={t("common.close")} onClick={() => setOpen(false)} className="absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-full text-white/80 hover:bg-white/10">
            <CloseIcon />
          </button>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-accent">{t("fy.why")}</p>
          <p data-testid="foryou-reason" className="mb-3 line-clamp-5 text-xs leading-snug">
            {why}
          </p>
          {quick.enabled && (
            <button
              type="button"
              data-testid="foryou-quick"
              onClick={() => {
                setOpen(false);
                quick.show(card.current);
              }}
              className="mb-1.5 min-h-[36px] rounded-lg bg-white/15 px-2 text-xs font-semibold hover:bg-white/25"
            >
              {t("quick.menu")}
            </button>
          )}
          <button
            type="button"
            data-testid="foryou-dismiss"
            onClick={() => {
              setOpen(false);
              onDismiss();
            }}
            className="min-h-[36px] rounded-lg bg-white/15 px-2 text-xs font-semibold hover:bg-danger"
          >
            {t("fy.dismiss")}
          </button>
        </div>
      )}
      {quick.open && <QuickSheet item={m} anchor={quick.anchor} onClose={quick.close} onDismiss={onDismiss} />}
    </div>
  );
}

function Arrow({ dir, hidden, onClick, label }: { dir: 1 | -1; hidden: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      tabIndex={-1}
      className={`absolute top-[calc(50%-2.5rem)] z-[1] hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-bg/85 text-xl text-text shadow-xl backdrop-blur transition hover:bg-surface-2 md:flex ${
        dir < 0 ? "-left-3" : "-right-3"
      } ${hidden ? "pointer-events-none opacity-0" : "opacity-0 group-hover/row:opacity-100"}`}
    >
      {dir < 0 ? <ChevronLeft /> : <ChevronRight />}
    </button>
  );
}

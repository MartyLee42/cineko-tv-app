// Quick actions on poster cards without opening the title: ♥ «Нравится»,
// «Буду смотреть», the 1–10 rating, «Не интересно». Desktop: small buttons on
// hover / keyboard focus; touch: «⋯» or a long press opens the sheet. Same
// mutations as the title page (useToggleList / useRate patch every cached
// copy), so rows, grids and the title page agree at once.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import type { MediaSummary } from "@martytv/contracts";
import { useI18n, type MessageKey } from "@martytv/ui";
import { BookmarkIcon, CloseIcon, HeartIcon, StarIcon } from "../icons";
import { useDismiss } from "../foryou/queries";
import { useActiveProfile } from "./ActiveProfile";
import { RatingScale } from "./RatingScale";
import { useRate, useToggleList } from "./queries";
import { useScrollLock } from "../scrollLock";

const btn = "pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full bg-black/70 text-[15px] text-white shadow-md transition hover:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** Over the poster (absolute, the card's poster box): hover buttons (desktop) and «⋯» (touch). */
export function QuickActions({ item, onMenu }: { item: MediaSummary; onMenu: (anchor: HTMLElement) => void }) {
  const { t } = useI18n();
  const toggle = useToggleList();
  const fav = !!item.me?.favorite;
  const want = !!item.me?.in_watchlist;
  const rating = item.me?.rating ?? null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-[1] aspect-[2/3]">
      {/* Desktop: on hover / when a button has keyboard focus. */}
      <div
        data-testid="quick-bar"
        className="absolute inset-x-0 bottom-2.5 hidden justify-center gap-1.5 opacity-0 transition group-hover/card:opacity-100 group-focus-within/card:opacity-100 [@media(hover:hover)]:flex"
      >
        <button
          type="button"
          aria-pressed={fav}
          aria-label={`${fav ? t("quick.unlike") : t("quick.like")}: ${item.title}`}
          title={fav ? t("quick.unlike") : t("quick.like")}
          data-testid="quick-like"
          onClick={() => toggle.mutate({ list: "favorites", mediaId: item.id, on: !fav })}
          className={`${btn} ${fav ? "text-rose-400" : ""}`}
        >
          <HeartIcon filled={fav} />
        </button>
        <button
          type="button"
          aria-pressed={want}
          aria-label={`${want ? t("quick.unwant") : t("quick.want")}: ${item.title}`}
          title={want ? t("quick.unwant") : t("quick.want")}
          data-testid="quick-want"
          onClick={() => toggle.mutate({ list: "watchlist", mediaId: item.id, on: !want })}
          className={`${btn} ${want ? "text-accent" : ""}`}
        >
          <BookmarkIcon filled={want} />
        </button>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={`${t("quick.rating")}: ${item.title}`}
          title={t("quick.rating")}
          data-testid="quick-rate"
          onClick={(e) => onMenu(e.currentTarget)}
          className={`${btn} w-auto min-w-8 gap-0.5 px-2 text-xs font-bold ${rating != null ? "text-accent" : ""}`}
        >
          <StarIcon />
          {rating != null && <span>{rating}</span>}
        </button>
      </div>
      {/* Touch: «⋯» (a long press on the card does the same). */}
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={`${t("quick.more")}: ${item.title}`}
        data-testid="quick-more"
        onClick={(e) => onMenu(e.currentTarget)}
        className={`${btn} absolute bottom-2.5 left-1.5 h-7 w-7 text-sm font-bold leading-none [@media(hover:hover)]:hidden`}
      >
        ⋯
      </button>
    </div>
  );
}

/**
 * The sheet: a popover next to `anchor` on wide screens, a bottom sheet on
 * phones. Esc / outside tap closes.
 */
export function QuickSheet({ item, anchor, onClose, onDismiss }: { item: MediaSummary; anchor: HTMLElement | null; onClose: () => void; onDismiss?: () => void }) {
  const { t } = useI18n();
  const toggle = useToggleList();
  const rate = useRate();
  const dismiss = useDismiss();
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Centred card on phones: keep the page behind it still.
  useScrollLock(!pos);
  const [saved, setSaved] = useState<string | null>(null);
  const fav = !!item.me?.favorite;
  const want = !!item.me?.in_watchlist;
  const rating = item.me?.rating ?? null;

  useLayoutEffect(() => {
    const place = () => {
      const r = anchor?.getBoundingClientRect();
      if (!r || window.innerWidth < 640) return setPos(null);
      // 20rem wide as a popover; the height is re-measured once it is laid out as one.
      const w = 320;
      const h = panel.current?.offsetHeight ?? 300;
      const left = Math.max(16, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 16));
      const below = r.bottom + 8;
      const top = below + h <= window.innerHeight - 16 ? below : Math.max(16, r.top - h - 8);
      setPos({ left, top });
    };
    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    panel.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      // Back to the card's button that opened it.
      anchor?.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleBtn = "inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl border px-3 text-sm font-semibold transition";
  const off = "border-border bg-surface-2/60 text-text hover:border-accent";
  return createPortal(
    <div data-testid="quick-sheet-backdrop" className="fixed inset-0 z-50 bg-black/40 sm:bg-transparent" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-label={item.title}
        data-testid="quick-sheet"
        style={pos ? { position: "fixed", left: pos.left, top: pos.top } : undefined}
        className={`${pos ? "w-[20rem]" : "fixed left-1/2 top-1/2 max-h-[85%] w-[calc(100vw-1.5rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain"} rounded-2xl border border-border bg-surface p-4 shadow-2xl shadow-black/40`}
      >
        <div className="mb-3 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 font-bold leading-snug">{item.title}</p>
            <p className="text-xs text-muted">{[item.year, t(`catalog.kind.${item.kind}` as MessageKey)].filter(Boolean).join(" · ")}</p>
          </div>
          <button type="button" aria-label={t("common.close")} onClick={onClose} className="-mr-1 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2">
            <CloseIcon />
          </button>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            aria-pressed={fav}
            data-testid="quick-sheet-like"
            onClick={() => toggle.mutate({ list: "favorites", mediaId: item.id, on: !fav })}
            className={`${toggleBtn} ${fav ? "border-rose-500/60 bg-rose-500/15 text-rose-500" : off}`}
          >
            <HeartIcon filled={fav} className="text-base" />
            {t("quick.like")}
          </button>
          <button
            type="button"
            aria-pressed={want}
            data-testid="quick-sheet-want"
            onClick={() => toggle.mutate({ list: "watchlist", mediaId: item.id, on: !want })}
            className={`${toggleBtn} ${want ? "border-accent bg-accent/15 text-accent-strong" : off}`}
          >
            <BookmarkIcon filled={want} className="text-base" />
            {t("quick.want")}
          </button>
        </div>
        <div className="mt-4 flex items-baseline justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">{t("quick.rating")}</p>
          <p data-testid="quick-sheet-rating" className="text-sm font-bold text-accent-strong" aria-live="polite">
            {saved ?? (rating != null ? `★ ${rating}` : t("quick.rating_none"))}
          </p>
        </div>
        <div className="mt-2">
          <RatingScale
            size="sm"
            value={rating}
            onPick={(n) => {
              // The same score again removes it (as on the title page).
              const next = n === rating ? null : n;
              rate.mutate({ mediaId: item.id, rating: next, prev: rating });
              setSaved(next == null ? t("quick.unrated") : t("quick.rated", { n: next }));
            }}
          />
        </div>
        <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
          <button
            type="button"
            data-testid="quick-sheet-dismiss"
            onClick={() => {
              if (onDismiss) onDismiss();
              else dismiss.mutate({ mediaId: item.id, rowId: "card" });
              onClose();
            }}
            className="min-h-[40px] rounded-lg px-2 text-sm font-semibold text-muted hover:bg-surface-2 hover:text-danger"
          >
            {t("fy.dismiss")}
          </button>
          <Link to={`/title/${item.id}`} onClick={onClose} className="min-h-[40px] rounded-lg px-2 py-2 text-sm font-semibold text-accent-strong hover:bg-surface-2">
            {t("quick.open")} →
          </Link>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The card's state: which card's sheet is open (anchor = the button / card that opened it). */
export function useQuickSheet() {
  const { profileId } = useActiveProfile();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  return {
    enabled: !!profileId,
    open,
    anchor,
    show: (a: HTMLElement | null) => {
      setAnchor(a);
      setOpen(true);
    },
    close: () => setOpen(false),
  };
}

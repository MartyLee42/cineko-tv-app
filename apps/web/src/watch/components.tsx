import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NoteEditor } from "../foryou/NoteEditor";
import { sideForRating } from "../foryou/notes";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import type { ContinueItem, MediaSummary } from "@martytv/contracts";
import { imageUrl, placeholderColor } from "@martytv/media-types";
import { useI18n } from "@martytv/ui";
import { Img } from "../catalog/components";
import { useCatalogConfig } from "../catalog/queries";
import { BookmarkIcon, ChevronLeft, ChevronRight, CloseIcon, DeviceIcon, EyeIcon, HeartIcon, ListIcon, PlayIcon, StarIcon, TvIcon } from "../icons";
import { useDevices } from "../queries";
import { Sheet, SendToTvProvider } from "../remote/SendToTv";
import { PlayOnTvProvider, usePlayOnTv, useWatchHere, type PlayTarget } from "../play/PlayOnTv";
import { readWatchWhere, type WatchWhere } from "../player/session";
import { clamp01, continueInfo, formatLeft } from "./format";
import { useActiveProfile } from "./ActiveProfile";
import { setHideWatchedOverride, useContinueWatching, useHideWatched, useHistory, useRate, useToggleList } from "./queries";
import { dismissRating, pendingRatings, readDismissed } from "./rate";

export function ProgressBar({ value, className = "", label }: { value: number; className?: string; label?: string }) {
  const pct = Math.round(clamp01(value) * 100);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={label}
      className={`h-1.5 overflow-hidden rounded-full bg-text/15 ${className}`}
    >
      <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------- continue watching

export function ContinueRow() {
  const q = useContinueWatching();
  if (!q.data?.length) return null;
  return (
    <SendToTvProvider>
      <PlayOnTvProvider>
        <ContinueRowBody items={q.data} />
      </PlayOnTvProvider>
    </SendToTvProvider>
  );
}

function ContinueRowBody({ items }: { items: ContinueItem[] }) {
  const { t } = useI18n();
  const scroller = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<ContinueItem | null>(null);
  const go = useContinueGo();
  const hasTv = !!useDevices().data?.length;
  const scroll = (dir: 1 | -1) => scroller.current?.scrollBy({ left: dir * scroller.current.clientWidth * 0.85, behavior: "smooth" });
  return (
    <section className="group/row" data-testid="row-continue">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-bold sm:text-xl">{t("watch.continue")}</h2>
        <Link to="/history" className="shrink-0 py-2 text-sm font-medium text-muted hover:text-accent">
          {t("watch.history")} →
        </Link>
      </div>
      <div className="relative">
        <div
          ref={scroller}
          className="no-scrollbar -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 sm:gap-4 md:mx-0 md:scroll-px-0 md:px-0"
        >
          {items.map((item) => (
            <ContinueCard key={item.media.id} item={item} onOpen={() => setOpen(item)} onGo={(w) => go(item, w)} hasTv={hasTv} />
          ))}
        </div>
        {items.length > 2 && (
          <>
            <ArrowBtn dir={-1} onClick={() => scroll(-1)} label={t("catalog.scroll_left")} />
            <ArrowBtn dir={1} onClick={() => scroll(1)} label={t("catalog.scroll_right")} />
          </>
        )}
      </div>
      {open && <ContinueSheet item={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** Where a "Continue watching" item resumes (episode / position). */
function continueTarget(item: ContinueItem): PlayTarget {
  const info = continueInfo(item);
  const m = item.media;
  const p = item.progress && !item.progress.completed ? item.progress : null;
  return {
    media_id: m.id,
    label: info.code ? `${m.title} · ${info.code}` : m.title,
    ...(info.episodeId && { episode_id: info.episodeId }),
    ...(p?.season_number != null
      ? { season_number: p.season_number, episode_number: p.episode_number ?? undefined }
      : item.next_up
        ? { season_number: item.next_up.season_number, episode_number: item.next_up.episode_number }
        : {}),
    position_seconds: info.position ?? 0,
  };
}

/** Resume a "Continue watching" item on the TV or in this browser. */
function useContinueGo() {
  const { play } = usePlayOnTv();
  const watchHere = useWatchHere();
  return (item: ContinueItem, w: WatchWhere) => (w === "tv" ? play(continueTarget(item)) : watchHere(continueTarget(item)));
}

/**
 * Tapping a "Continue watching" card: on the TV or here (the last choice
 * first), or the title page.
 */
function ContinueSheet({ item, onClose }: { item: ContinueItem; onClose: () => void }) {
  const { t } = useI18n();
  const info = continueInfo(item);
  const go = useContinueGo();
  const { data: devices } = useDevices();
  const [last] = useState<WatchWhere | null>(readWatchWhere);
  const m = item.media;
  const hasTv = !!devices?.length;
  const order: WatchWhere[] = last === "tv" && hasTv ? ["tv", "here"] : hasTv ? ["here", "tv"] : ["here"];
  const btn = (w: WatchWhere, primary: boolean) => (
    <button
      key={w}
      type="button"
      data-testid={`continue-${w}`}
      data-last={w === last || undefined}
      onClick={() => {
        onClose();
        go(item, w);
      }}
      className={`flex min-h-[56px] w-full items-center gap-3 rounded-2xl px-4 text-left font-semibold transition ${
        primary ? "bg-accent text-on-accent hover:bg-accent-strong" : "border border-border bg-surface-2 hover:border-accent"
      }`}
    >
      <span className={`text-xl ${primary ? "" : "text-accent"}`}>{w === "tv" ? <TvIcon /> : <DeviceIcon />}</span>
      <span className="flex-1">{w === "tv" ? t("player.play_on_tv") : t("player.web.watch_here")}</span>
      {w === last && <span className={`text-xs font-medium ${primary ? "text-on-accent/75" : "text-muted"}`}>{t("player.web.continue_last")}</span>}
    </button>
  );
  return (
    <Sheet title={m.title} subtitle={info.code ?? undefined} onClose={onClose} testId="continue-sheet">
      <div className="space-y-2.5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">{t("player.web.continue_title")}</p>
        {order.map((w, i) => btn(w, i === 0))}
        <Link
          to={info.href}
          onClick={onClose}
          data-testid="continue-details"
          className="flex min-h-[48px] items-center gap-3 rounded-2xl px-4 font-semibold text-text/85 hover:bg-surface-2"
        >
          <ListIcon className="text-xl text-muted" />
          {t("player.web.continue_details")}
        </Link>
      </div>
    </Sheet>
  );
}

function ArrowBtn({ dir, onClick, label }: { dir: 1 | -1; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      tabIndex={-1}
      onClick={onClick}
      className={`absolute top-[calc(50%-1.5rem)] z-[1] hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-bg/85 text-xl text-text opacity-0 shadow-xl backdrop-blur transition hover:bg-surface-2 group-hover/row:opacity-100 md:flex ${
        dir < 0 ? "-left-3" : "-right-3"
      }`}
    >
      {dir < 0 ? <ChevronLeft /> : <ChevronRight />}
    </button>
  );
}

function ContinueCard({ item, onOpen, onGo, hasTv }: { item: ContinueItem; onOpen: () => void; onGo: (w: WatchWhere) => void; hasTv: boolean }) {
  const { t, locale } = useI18n();
  const { data: cfg } = useCatalogConfig();
  const info = continueInfo(item);
  const m = item.media;
  const left = item.progress && !item.progress.completed ? formatLeft(item.progress, locale) : null;
  const sub = [
    info.code && (info.position == null && item.next_up ? t("watch.next_up", { code: info.code }) : info.code),
    left && t("watch.left", { time: left }),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Link
      to={info.href}
      data-testid="continue-card"
      className="group block w-[15.5rem] shrink-0 snap-start text-left outline-none sm:w-72"
    >
      <div
        className="relative aspect-video overflow-hidden rounded-xl shadow-lg shadow-black/25 ring-1 ring-black/5 transition group-hover:-translate-y-0.5 group-focus-visible:ring-2 group-focus-visible:ring-accent"
        style={{ background: placeholderColor(m.title || m.id) }}
      >
        <Img
          src={imageUrl(cfg, m.backdrop_path ?? m.poster_path, "w780")}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          fallback={null}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-transparent" />
        {/* Tap the card → the title page (pick a season/episode); ▶ → resume now (here or on TV). */}
        <button
          type="button"
          data-testid="continue-play"
          aria-label={t("watch.resume_now")}
          title={t("watch.resume_now")}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onOpen();
          }}
          className="absolute left-1/2 top-1/2 flex h-12 w-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-lg text-white opacity-90 transition hover:scale-105 hover:bg-accent hover:text-on-accent focus-visible:ring-2 focus-visible:ring-accent"
        >
          <PlayIcon className="translate-x-px" />
        </button>
        <p className="absolute inset-x-3 bottom-3 line-clamp-1 text-sm font-semibold text-white drop-shadow">{m.title}</p>
        {info.percent > 0 && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-white/25">
            <div className="h-full bg-accent" style={{ width: `${Math.max(3, Math.round(info.percent * 100))}%` }} />
          </div>
        )}
      </div>
      {sub && <p className="mt-1.5 truncate text-xs text-muted">{sub}</p>}
      {/* Resume right away: in this browser, or on the TV. */}
      <div className="mt-2 flex gap-2">
        {(hasTv ? (["here", "tv"] as const) : (["here"] as const)).map((w) => (
          <button
            key={w}
            type="button"
            data-testid={`continue-card-${w}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onGo(w);
            }}
            className="inline-flex min-h-[36px] flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2.5 text-xs font-semibold text-text transition hover:border-accent hover:text-accent"
          >
            {w === "tv" ? <TvIcon className="text-base" /> : <DeviceIcon className="text-base" />}
            {w === "tv" ? t("watch.continue_on_tv") : t("watch.continue_here")}
          </button>
        ))}
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------- lists & rating

export function ListToggles({ m, className = "" }: { m: MediaSummary; className?: string }) {
  const { t } = useI18n();
  const { profileId } = useActiveProfile();
  const toggle = useToggleList();
  if (!profileId) return null;
  const inList = !!m.me?.in_watchlist;
  const fav = !!m.me?.favorite;
  const base =
    "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border px-3.5 text-sm font-semibold backdrop-blur transition";
  const off = "border-border bg-surface/70 text-text hover:border-accent";
  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      <button
        type="button"
        aria-pressed={inList}
        data-testid="toggle-watchlist"
        onClick={() => toggle.mutate({ list: "watchlist", mediaId: m.id, on: !inList })}
        className={`${base} ${inList ? "border-accent bg-accent/15 text-accent-strong" : off}`}
      >
        <BookmarkIcon filled={inList} className="text-lg" />
        {inList ? t("lists.in_watchlist") : t("lists.watchlist")}
      </button>
      <button
        type="button"
        aria-pressed={fav}
        aria-label={fav ? t("lists.remove_favorite") : t("lists.add_favorite")}
        title={fav ? t("lists.remove_favorite") : t("lists.add_favorite")}
        data-testid="toggle-favorite"
        onClick={() => toggle.mutate({ list: "favorites", mediaId: m.id, on: !fav })}
        className={`${base} w-11 px-0 ${fav ? "border-rose-500/60 bg-rose-500/15 text-rose-500" : off}`}
      >
        <HeartIcon filled={fav} className="text-lg" />
      </button>
      <RatingControl m={m} />
    </div>
  );
}

/** "Rate" button with a floating 1–10 popover (never changes the layout). */
export function RatingControl({ m }: { m: MediaSummary }) {
  const { t } = useI18n();
  const rate = useRate();
  const [open, setOpen] = useState(false);
  // After picking a score the popover stays open with «Почему?».
  const [picked, setPicked] = useState<number | null>(null);
  const [why, setWhy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(null);
  const rating = m.me?.rating ?? null;

  // The popover is portalled to <body> with fixed coordinates, so the title
  // hero's overflow:hidden can't clip it; it opens upward near the bottom.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = box.current?.getBoundingClientRect();
      if (!r) return;
      const w = Math.min(304, window.innerWidth - 32);
      const left = Math.max(16, Math.min(r.left, window.innerWidth - w - 16));
      // The «Почему?» editor makes it taller: measure, flip up, or clamp on screen.
      const h = Math.max(140, pop.current?.offsetHeight ?? 0);
      const up = window.innerHeight - r.bottom < h + 16 && r.top > h + 16;
      const top = up ? r.top - 8 : Math.max(16, Math.min(r.bottom + 8, window.innerHeight - h - 16));
      setPos({ left, top, up });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, why, picked]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || pop.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="rate-button"
        onClick={() => {
          setOpen((o) => !o);
          setPicked(null);
          setWhy(false);
        }}
        className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border px-3.5 text-sm font-semibold backdrop-blur transition ${
          rating != null ? "border-accent bg-accent/15 text-accent-strong" : "border-border bg-surface/70 text-text hover:border-accent"
        }`}
      >
        <StarIcon className={rating != null ? "text-accent" : "text-muted"} />
        {rating != null ? t("lists.your_rating", { n: rating }) : t("lists.rate")}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={pop}
            role="dialog"
            aria-label={t("lists.rate")}
            data-testid="rate-popover"
            style={{ position: "fixed", left: pos.left, top: pos.top, transform: pos.up ? "translateY(-100%)" : undefined }}
            className="z-50 w-[min(19rem,calc(100vw-2rem))] rounded-2xl border border-border bg-surface p-2.5 shadow-2xl shadow-black/40"
          >
            <RatingScale
              size="sm"
              value={rating}
              onPick={(n) => {
                rate.mutate({ mediaId: m.id, rating: n === rating ? null : n, prev: rating });
                if (n === rating) setOpen(false);
                else setPicked(n);
              }}
            />
            {/* After a score: «Почему?» expands reason chips (dislike ≤ 5, like ≥ 8) + text. */}
            {picked != null &&
              (why ? (
                <div className="mt-2 border-t border-border pt-2.5">
                  <NoteEditor mediaId={m.id} initial={m.me?.note} side={sideForRating(picked)} testId="rate-note" onSaved={() => setOpen(false)} />
                </div>
              ) : (
                <button type="button" data-testid="rate-why" onClick={() => setWhy(true)} className="mt-1.5 px-1 text-sm font-semibold text-accent-strong underline-offset-2 hover:underline">
                  {t("taste.why")}
                </button>
              ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

export function RatingScale({ value, onPick, size = "md" }: { value: number | null; onPick: (n: number) => void; size?: "sm" | "md" }) {
  const { t } = useI18n();
  return (
    <div role="radiogroup" aria-label={t("lists.rate")} className="flex flex-wrap gap-1.5" data-testid="rating-scale">
      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
        const on = value === n;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onPick(n)}
            className={`${size === "sm" ? "h-9 w-9 text-sm" : "h-10 w-10"} rounded-full border font-bold transition ${
              on
                ? "border-accent bg-accent text-on-accent"
                : value != null && n < value
                  ? "border-accent/50 bg-accent/15 text-accent-strong"
                  : "border-border bg-surface text-text hover:border-accent"
            }`}
          >
            {n}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- rate prompt

/** Home card: "How was X?" for titles finished in the last 48 h without a rating. */
export function RatePrompt({ only }: { only?: string }) {
  const { t } = useI18n();
  const { data: cfg } = useCatalogConfig();
  const history = useHistory();
  const rate = useRate();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [thanks, setThanks] = useState<string | null>(null);
  useEffect(() => {
    if (!thanks) return;
    const id = setTimeout(() => setThanks(null), 2500);
    return () => clearTimeout(id);
  }, [thanks]);

  const items = pendingRatings(history.data?.pages.flatMap((p) => p.items), dismissed).filter((m) => !only || m.id === only);
  if (thanks) {
    return (
      <div role="status" className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm font-semibold text-ok">
        {t("rate.thanks")}
      </div>
    );
  }
  const m = items[0];
  if (!m) return null;
  return (
    <section
      data-testid="rate-prompt"
      className="flex gap-3 rounded-2xl border border-border bg-surface p-3 shadow-sm sm:items-center sm:gap-4 sm:p-4"
    >
      {!only && (
        <Link to={`/title/${m.id}`} className="w-14 shrink-0 self-start sm:w-16">
          <div className="relative aspect-[2/3] overflow-hidden rounded-lg" style={{ background: placeholderColor(m.title) }}>
            <Img src={imageUrl(cfg, m.poster_path, "w185")} alt="" className="absolute inset-0 h-full w-full object-cover" fallback={null} />
          </div>
        </Link>
      )}
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {!only && <p className="text-xs font-semibold uppercase tracking-wider text-accent">{t("rate.pending")}</p>}
            <h2 className="font-bold leading-snug">{t("rate.title", { title: m.title })}</h2>
            <p className="text-sm text-muted">{t("rate.subtitle")}</p>
          </div>
          <button
            type="button"
            aria-label={t("rate.skip")}
            title={t("rate.skip")}
            data-testid="rate-skip"
            onClick={() => setDismissed(dismissRating(m.id))}
            className="-mr-1 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-text"
          >
            <CloseIcon />
          </button>
        </div>
        <RatingScale
          size="sm"
          value={null}
          onPick={(n) => {
            rate.mutate({ mediaId: m.id, rating: n, prev: null });
            setThanks(m.id);
          }}
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- hide watched quick toggle

/** Browse/Search chip: overrides the profile's hide_watched for this session. */
export function HideWatchedToggle({ className = "" }: { className?: string }) {
  const { t } = useI18n();
  const { profileId } = useActiveProfile();
  const on = useHideWatched();
  if (!profileId) return null;
  return (
    <button
      type="button"
      aria-pressed={on}
      data-testid="hide-watched-toggle"
      onClick={() => setHideWatchedOverride(!on)}
      className={`inline-flex min-h-[40px] items-center gap-2 rounded-xl border px-3.5 text-sm font-semibold transition ${
        on ? "border-accent bg-accent/15 text-accent-strong" : "border-border bg-surface text-text/85 hover:border-muted"
      } ${className}`}
    >
      <EyeIcon off={on} className="text-base" />
      {t("watch.hide_watched_toggle")}
    </button>
  );
}

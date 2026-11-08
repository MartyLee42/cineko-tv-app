// «Видео» building blocks: video cards (grid / compact row), thumbnails with
// the duration / ЭФИР badge and progress, channel avatars, the subscribe
// button and the empty / unavailable / error states.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Spinner, useI18n, type MessageKey } from "@martytv/ui";
import { Button, ErrorText } from "../components";
import { AlertIcon, CheckIcon, PlayIcon } from "../icons";
import { compactCount, countForm, formatDuration, isVideoUnavailable, progressPercent, relativeDate, retryDelay, type VideoItem } from "./logic";
import { THUMB_SIZES, thumbSrcSet, useGridPrefetch } from "./prefetch";
import { useSubscribe } from "./queries";

export const watchHref = (id: string) => `/video/watch/${encodeURIComponent(id)}`;
export const channelHref = (id: string) => `/video/channel/${encodeURIComponent(id)}`;

/** Count / date formatting in the current locale. */
export function useVideoFormat() {
  const { t, locale } = useI18n();
  const [now] = useState(() => Date.now());
  return useMemo(
    () => ({
      views: (n: number | null | undefined) => (n == null ? "" : t(`video.web.views.${countForm(n, locale)}` as MessageKey, { count: compactCount(n, locale) })),
      subs: (n: number | null | undefined) => (n == null ? "" : t(`video.web.subs.${countForm(n, locale)}` as MessageKey, { count: compactCount(n, locale) })),
      date: (iso: string | null | undefined) => relativeDate(iso, now, locale),
    }),
    [t, locale, now],
  );
}

/** «1,2 млн просмотров · 3 дня назад» (live: just the views). */
export function VideoMeta({ v, className = "" }: { v: VideoItem; className?: string }) {
  const f = useVideoFormat();
  const parts = [f.views(v.views), v.live ? "" : f.date(v.published_at)].filter(Boolean);
  if (!parts.length) return null;
  return (
    <p className={`truncate text-xs text-muted sm:text-[13px] ${className}`} data-testid="video-meta">
      {parts.join(" · ")}
    </p>
  );
}

/**
 * A card's thumbnail: srcset 320w (mqdefault) / 480w (hqdefault), the browser
 * takes the smallest that fits `sizes` (default: the compact row's width).
 * The first cards (eager) load at high priority, the rest lazily at low.
 */
export function Thumb({
  v,
  className = "",
  hd = false,
  eager = false,
  flush = false,
  sizes = THUMB_SIZES.compact,
}: {
  v: VideoItem;
  className?: string;
  hd?: boolean;
  eager?: boolean;
  flush?: boolean;
  sizes?: string;
}) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const pct = progressPercent(v.progress, v.duration_seconds);
  const dur = formatDuration(v.duration_seconds);
  return (
    <div className={`relative aspect-video overflow-hidden bg-surface-2 ${flush ? "-mx-4 sm:mx-0 sm:rounded-xl" : "rounded-xl"} ${className}`}>
      {!failed && (
        <img
          src={hd ? v.thumbnail_hd : v.thumbnail}
          srcSet={thumbSrcSet(v)}
          sizes={sizes}
          alt=""
          loading={eager ? "eager" : "lazy"}
          fetchPriority={eager ? "high" : "low"}
          decoding="async"
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {v.live ? (
        <span className="absolute bottom-1.5 right-1.5 rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white" data-testid="video-live">
          {t("video.live")}
        </span>
      ) : v.upcoming ? (
        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1.5 py-0.5 text-[11px] font-semibold text-white">{t("video.web.upcoming")}</span>
      ) : (
        dur && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-white" data-testid="video-duration">
            {dur}
          </span>
        )
      )}
      {v.short && !v.live && (
        <span className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white">{t("video.short")}</span>
      )}
      {pct > 0 && (
        <div className="absolute inset-x-0 bottom-0 h-1 bg-white/30" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-testid="video-progress">
          <div className="h-full bg-red-600" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/** Grid card: thumbnail, title, channel, views · date. `action` sits next to the title (e.g. remove). */
export function VideoCard({ v, action, eager, inRow = false, idx }: { v: VideoItem; action?: ReactNode; eager?: boolean; inRow?: boolean; idx?: number }) {
  return (
    <article className="group min-w-0" data-testid="video-card" data-video-id={v.id} data-thumb-idx={idx}>
      <Link to={watchHref(v.id)} className="block" data-testid="video-link">
        <Thumb v={v} hd eager={eager} flush={!inRow} sizes={inRow ? THUMB_SIZES.row : THUMB_SIZES.grid} />
      </Link>
      <div className="mt-2.5 flex gap-2">
        <div className="min-w-0 flex-1">
          <Link to={watchHref(v.id)} className="line-clamp-2 font-semibold leading-snug hover:underline" data-testid="video-title">
            {v.title}
          </Link>
          <Link to={channelHref(v.channel_id)} className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-xs text-muted hover:text-text sm:text-[13px]" data-testid="video-channel">
            <span className="truncate">{v.channel_name}</span>
            {v.channel_verified && <CheckIcon className="shrink-0 text-[0.9em]" />}
          </Link>
          <VideoMeta v={v} />
        </div>
        {action}
      </div>
    </article>
  );
}

/** Compact row card (related videos, phone lists): small thumbnail left, text right. */
export function VideoRow({ v }: { v: VideoItem }) {
  return (
    <Link to={watchHref(v.id)} className="group flex min-w-0 gap-3 rounded-xl" data-testid="video-row" data-video-id={v.id}>
      <Thumb v={v} className="w-40 shrink-0 sm:w-44" />
      <span className="min-w-0 flex-1 py-0.5">
        <span className="line-clamp-2 text-sm font-semibold leading-snug group-hover:underline">{v.title}</span>
        <span className="mt-1 block truncate text-xs text-muted">{v.channel_name}</span>
        <VideoMeta v={v} />
      </span>
    </Link>
  );
}

export function VideoGrid({ items, action }: { items: VideoItem[]; action?: (v: VideoItem) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Cards nearing the screen fetch the next ones' thumbnails ahead.
  useGridPrefetch(ref, items, THUMB_SIZES.grid);
  return (
    <div ref={ref} className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-testid="video-grid">
      {items.map((v, i) => (
        <VideoCard key={v.id} v={v} action={action?.(v)} eager={i < 4} idx={i} />
      ))}
    </div>
  );
}

export function GridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-hidden data-testid="video-skeleton">
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>
          <div className="aspect-video animate-pulse rounded-xl bg-surface-2" />
          <div className="mt-2.5 h-4 w-4/5 animate-pulse rounded bg-surface-2" />
          <div className="mt-1.5 h-3 w-1/2 animate-pulse rounded bg-surface-2" />
        </div>
      ))}
    </div>
  );
}

export function ChannelAvatar({ name, src, size = 40, className = "" }: { name: string; src: string | null | undefined; size?: number; className?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = !!src && failedSrc === src;
  const letter = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-2 font-bold text-muted ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden
    >
      {src && !failed ? <img src={src} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" onError={() => setFailedSrc(src)} /> : letter}
    </span>
  );
}

/** «Подписаться» / «Вы подписаны» (needs a profile). */
export function SubscribeButton({ channelId, subscribed, className = "" }: { channelId: string; subscribed: boolean; className?: string }) {
  const { t } = useI18n();
  const sub = useSubscribe();
  return (
    <button
      type="button"
      onClick={() => sub.mutate({ channelId, on: !subscribed })}
      aria-pressed={subscribed}
      data-testid="video-subscribe"
      title={subscribed ? t("video.unsubscribe") : t("video.subscribe")}
      className={`inline-flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-semibold transition ${
        subscribed ? "bg-surface-2 text-text hover:bg-border" : "bg-text text-bg hover:opacity-85"
      } ${className}`}
    >
      {subscribed && <CheckIcon />}
      {subscribed ? t("video.subscribed") : t("video.subscribe")}
    </button>
  );
}

export function EmptyState({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-6 py-12 text-center text-muted" data-testid="video-empty">
      <span className="text-3xl text-muted/70">{icon ?? <PlayIcon />}</span>
      <div className="max-w-sm">{children}</div>
    </div>
  );
}

/** 503 video_unavailable → the friendly message; anything else → the error + retry. */
export function VideoError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  if (isVideoUnavailable(error)) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-warn/40 bg-warn/10 px-6 py-10 text-center" data-testid="video-unavailable">
        <AlertIcon className="text-3xl text-warn" />
        <p className="max-w-md">{t("video.unavailable")}</p>
        {onRetry && (
          <Button variant="secondary" onClick={onRetry}>
            {t("common.retry")}
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <ErrorText error={error} />
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}

/**
 * Infinite scroll for a paged list: a sentinel below the items loads the next
 * page as it nears the viewport («Показать ещё» stays as a fallback). A failed
 * page keeps what is shown, says so inline and retries by itself with backoff.
 */
export function LoadMore({ hasMore, loading, error, onMore }: { hasMore: boolean; loading: boolean; error: unknown; onMore: () => void }) {
  const { t } = useI18n();
  const sentinel = useRef<HTMLDivElement>(null);
  const failed = !!error;
  const more = useRef(onMore);
  useEffect(() => {
    more.current = onMore;
  });
  // Near the end: load the next page (not while one loads or after a failure — that retries on its own).
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || loading || failed || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) more.current();
    }, { rootMargin: "0px 0px 800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, failed]);
  // A failed page: retry after 2 s, 4 s, 8 s… (≤ 30 s); a success resets the count.
  const attempt = useRef(0);
  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => more.current(), retryDelay(attempt.current++));
    return () => clearTimeout(id);
  }, [error]);
  useEffect(() => {
    if (!error && !loading) attempt.current = 0;
  }, [error, loading]);

  if (!hasMore && !failed) return null;
  return (
    <div ref={sentinel} className="mt-6 flex min-h-[48px] flex-col items-center justify-center gap-2" data-testid="video-load-more-box">
      {failed ? (
        <p role="status" className="flex flex-wrap items-center justify-center gap-3 text-sm text-muted" data-testid="video-load-failed">
          {t("video.web.load_failed")}
          <Button variant="secondary" onClick={onMore} disabled={loading}>
            {t("common.retry")}
          </Button>
        </p>
      ) : loading ? (
        <Spinner size={22} />
      ) : (
        <Button variant="secondary" onClick={onMore} data-testid="video-load-more">
          {t("video.web.load_more")}
        </Button>
      )}
    </div>
  );
}

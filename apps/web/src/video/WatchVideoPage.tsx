// /video/watch/:id — the player, title, views · date · likes, channel row
// with «Подписаться», actions («Смотреть позже», «На ТВ»), the description
// (collapsed, links clickable) and related videos (below on phones, a side
// column from lg up).
import { useCallback, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useI18n } from "@martytv/ui";
import { ChevronLeft, BookmarkIcon, CastIcon, CheckIcon, HeartIcon } from "../icons";
import { useActiveProfile } from "../watch/ActiveProfile";
import { compactCount, isNotFound, linkify } from "./logic";
import { useVideoDetail, useWatchLaterToggle, type VideoDetail } from "./queries";
import { SendVideoProvider, useSendVideo } from "./SendVideo";
import { ChannelAvatar, channelHref, EmptyState, SubscribeButton, VideoError, VideoRow, useVideoFormat } from "./ui";
import { VideoPlayer, type PlayerHandle } from "./VideoPlayer";

export function WatchVideoPage() {
  return (
    <SendVideoProvider>
      <WatchVideo />
    </SendVideoProvider>
  );
}

function WatchVideo() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const q = useVideoDetail(id);
  const v = q.data;

  const back = (
    <button
      type="button"
      onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/video"))}
      className="-ml-2 mb-2 inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-muted hover:text-text"
      data-testid="video-back"
    >
      <ChevronLeft />
      {t("video.title")}
    </button>
  );

  if (q.isPending) {
    return (
      <div>
        {back}
        <div className="-mx-4 aspect-video animate-pulse bg-surface-2 sm:mx-0 sm:rounded-2xl" />
        <div className="mt-4 h-6 w-3/4 animate-pulse rounded bg-surface-2" />
      </div>
    );
  }
  if (!v) {
    return (
      <div>
        {back}
        {isNotFound(q.error) ? <EmptyState>{t("video.web.not_found")}</EmptyState> : <VideoError error={q.error} onRetry={() => void q.refetch()} />}
      </div>
    );
  }
  return (
    <div data-testid="video-watch" data-video-id={v.id}>
      {back}
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-6">
        <Main v={v} />
        {v.related.length > 0 && (
          <aside className="mt-8 lg:mt-0" data-testid="video-related">
            <h2 className="mb-3 text-lg font-bold">{t("video.related")}</h2>
            <div className="space-y-3">
              {v.related.map((r) => (
                <VideoRow key={r.id} v={r} />
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function Main({ v }: { v: VideoDetail }) {
  const { t, locale } = useI18n();
  const f = useVideoFormat();
  const { profileId } = useActiveProfile();
  const later = useWatchLaterToggle();
  const { send } = useSendVideo();
  const player = useRef<PlayerHandle | null>(null);
  const onReady = useCallback((h: PlayerHandle) => {
    player.current = h;
  }, []);
  const meta = [f.views(v.views), v.live ? "" : f.date(v.published_at)].filter(Boolean).join(" · ");

  return (
    <div className="min-w-0">
      {v.playable ? (
        <VideoPlayer key={v.id} videoId={v.id} poster={v.thumbnail_hd} qualities={v.qualities} startAt={v.progress?.finished ? 0 : v.progress?.position_seconds} onReady={onReady} />
      ) : (
        <div className="relative -mx-4 aspect-video overflow-hidden bg-black sm:mx-0 sm:rounded-2xl">
          <img src={v.thumbnail_hd} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" />
          <p className="absolute inset-0 flex items-center justify-center px-6 text-center font-semibold text-white" data-testid="video-unplayable">
            {v.live || v.upcoming ? t("video.live_unsupported") : t("video.unplayable")}
          </p>
        </div>
      )}
      <h1 className="mt-3 text-lg font-bold leading-snug sm:text-xl" data-testid="video-watch-title">
        {v.title}
      </h1>
      <p className="mt-1 text-sm text-muted">
        {meta}
        {v.likes != null && (
          <span className="ml-2 inline-flex items-center gap-1 whitespace-nowrap" title={t("video.web.likes")}>
            · <HeartIcon className="text-[0.95em]" /> {compactCount(v.likes, locale)}
          </span>
        )}
      </p>

      <div className="mt-4 flex items-center gap-3">
        <Link to={channelHref(v.channel.id)} className="flex min-w-0 flex-1 items-center gap-3" data-testid="video-watch-channel">
          <ChannelAvatar name={v.channel.name} src={v.channel.avatar} size={44} />
          <span className="min-w-0">
            <span className="flex items-center gap-1 truncate font-semibold">
              <span className="truncate">{v.channel.name}</span>
              {v.channel.verified && <CheckIcon className="shrink-0 text-[0.85em] text-muted" />}
            </span>
            <span className="block truncate text-xs text-muted">{f.subs(v.channel.subscribers)}</span>
          </span>
        </Link>
        {profileId && <SubscribeButton channelId={v.channel.id} subscribed={v.channel.subscribed} />}
      </div>

      <div className="no-scrollbar -mx-4 mt-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        {profileId && (
          <button
            type="button"
            aria-pressed={v.in_watch_later}
            onClick={() => later.mutate({ videoId: v.id, on: !v.in_watch_later })}
            className={`inline-flex min-h-[40px] shrink-0 items-center gap-2 rounded-full px-4 text-sm font-semibold transition ${
              v.in_watch_later ? "bg-accent/15 text-accent" : "bg-surface-2 hover:bg-border"
            }`}
            data-testid="video-watch-later"
          >
            {v.in_watch_later ? <CheckIcon /> : <BookmarkIcon />}
            {v.in_watch_later ? t("video.in_watch_later") : t("video.add_watch_later")}
          </button>
        )}
        {v.playable && (
          <button
            type="button"
            onClick={() => send(v.id, player.current?.position())}
            className="inline-flex min-h-[40px] shrink-0 items-center gap-2 rounded-full bg-surface-2 px-4 text-sm font-semibold transition hover:bg-border"
            data-testid="video-send-tv"
          >
            <CastIcon />
            {t("video.send_to_tv")}
          </button>
        )}
      </div>

      {v.description.trim() && <Description text={v.description} />}
    </div>
  );
}

function Description({ text }: { text: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const long = text.length > 240 || text.split("\n").length > 4;
  return (
    <div className="mt-4 rounded-2xl bg-surface-2 p-3.5 text-sm" data-testid="video-description">
      <p className={`whitespace-pre-line break-words leading-relaxed ${open || !long ? "" : "line-clamp-4"}`}>
        {linkify(text).map((p, i) =>
          p.href ? (
            <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent hover:underline">
              {p.text}
            </a>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
      </p>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1.5 min-h-[32px] font-semibold" data-testid="video-description-toggle">
          {open ? t("video.web.show_less") : t("video.web.show_more")}
        </button>
      )}
    </div>
  );
}

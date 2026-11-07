// /video/watch/:id — the player, title, views · date · likes, channel row
// with «Подписаться», actions («Смотреть позже», «На ТВ»), the description
// (collapsed, links clickable) and related videos (below on phones, a side
// column from lg up).
import { useCallback, useEffect, useRef, useState } from "react";
import { nextInSeries, pickNextVideo, seriesPart } from "@martytv/media-types";
import { useSettings } from "../watch/queries";
import { Link, useNavigate, useParams } from "react-router";
import { useI18n } from "@martytv/ui";
import { ChevronLeft, BookmarkIcon, CastIcon, CheckIcon, HeartIcon } from "../icons";
import { useActiveProfile } from "../watch/ActiveProfile";
import { compactCount, isNotFound, linkify } from "./logic";
import { fetchChannelUploads, useVideoDetail, useWatchLaterToggle, type VideoDetail } from "./queries";
import { SendVideoProvider, useSendVideo } from "./SendVideo";
import { ChannelAvatar, channelHref, watchHref, EmptyState, SubscribeButton, VideoError, VideoRow, useVideoFormat } from "./ui";
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
  const upNext = useUpNext(v);

  return (
    <div className="min-w-0">
      {v.playable ? (
        <div className="relative">
          <VideoPlayer key={v.id} videoId={v.id} poster={v.thumbnail_hd} qualities={v.qualities} startAt={v.progress?.finished ? 0 : v.progress?.position_seconds} onReady={onReady} onEnded={upNext.onEnded} />
          {upNext.card}
        </div>
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

type Next = { video: VideoDetail["related"][number]; why: "series" | "random"; n: number };
/** Played in this tab: random picks skip them (no ping-pong between two videos). */
const played = new Set<string>();

/**
 * «Автовоспроизведение» (video_autoplay): when the video ends, the next part
 * of its series (same channel), else a random related video — after a 5 s
 * card unless «Отсчёт перед следующим» is off.
 */
function useUpNext(v: VideoDetail) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const settings = useSettings();
  const { profileId } = useActiveProfile();
  const [next, setNext] = useState<Next | null>(null);
  useEffect(() => {
    played.add(v.id);
  }, [v.id]);
  const go = useCallback((id: string) => {
    setNext(null);
    navigate(watchHref(id));
  }, [navigate]);
  useEffect(() => {
    if (!next) return;
    const timer = setTimeout(() => (next.n > 1 ? setNext({ ...next, n: next.n - 1 }) : go(next.video.id)), 1000);
    return () => clearTimeout(timer);
  }, [next, go]);
  const onEnded = useCallback(async () => {
    if (settings.video_autoplay === false) return;
    let channel: VideoDetail["related"] = [];
    if (seriesPart(v.title) && !nextInSeries(v, v.related)) channel = await fetchChannelUploads(v.channel_id, profileId ?? undefined).catch(() => []);
    const pick = pickNextVideo(v, v.related, channel, { recent: played });
    if (!pick) return;
    if (settings.autoplay_countdown === false) return go(pick.video.id);
    setNext({ video: pick.video, why: pick.why, n: 5 });
  }, [v, settings.video_autoplay, settings.autoplay_countdown, profileId, go]);
  const card = next && (
    <div data-testid="video-up-next" data-why={next.why} className="absolute bottom-3 right-3 z-10 flex max-w-[calc(100%-1.5rem)] items-center gap-3 rounded-xl bg-black/85 p-3 text-white shadow-xl sm:w-[420px]">
      <img src={next.video.thumbnail} alt="" className="hidden h-[68px] w-[120px] shrink-0 rounded-lg object-cover sm:block" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-accent">
          {t("video.next.title")} · {t(next.why === "series" ? "video.next.series" : "video.next.random")} · {t("video.next.in", { n: next.n })}
        </p>
        <p className="mt-0.5 line-clamp-2 text-sm font-semibold">{next.video.title}</p>
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={() => go(next.video.id)} className="min-h-[36px] rounded-lg bg-white px-3 text-sm font-semibold text-black" data-testid="video-up-next-play">
            {t("video.next.play")}
          </button>
          <button type="button" onClick={() => setNext(null)} className="min-h-[36px] rounded-lg bg-white/15 px-3 text-sm font-semibold" data-testid="video-up-next-cancel">
            {t("video.next.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
  return { onEnded: () => void onEnded(), card };
}


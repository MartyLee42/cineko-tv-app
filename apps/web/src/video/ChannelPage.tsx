// /video/channel/:id — banner, avatar, name, subscribers, «Подписаться»,
// description and the latest uploads (infinite scroll through the channel's
// continuation, «Показать ещё» as a fallback).
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useI18n } from "@martytv/ui";
import { ChevronLeft, CheckIcon } from "../icons";
import { useActiveProfile } from "../watch/ActiveProfile";
import { appendUnique, isNotFound, type VideoItem } from "./logic";
import { useChannelMore, useVideoChannel } from "./queries";
import { ChannelAvatar, EmptyState, GridSkeleton, LoadMore, SubscribeButton, VideoError, VideoGrid, useVideoFormat } from "./ui";

export function VideoChannelPage() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { profileId } = useActiveProfile();
  const q = useVideoChannel(id);
  const f = useVideoFormat();
  const c = q.data;
  // Later uploads page by page (continuation), started when the first page's end comes near.
  const [started, setStarted] = useState(false);
  const more = useChannelMore(id, c?.continuation, started);
  const videos = useMemo(
    () => (more.data?.pages ?? []).reduce<VideoItem[]>((acc, p) => appendUnique(acc, p.items), c?.videos ?? []),
    [c?.videos, more.data],
  );
  const hasMore = started ? more.hasNextPage || (more.isError && !more.data) : !!c?.continuation;
  const loadMore = () => {
    if (!started) return setStarted(true);
    if (more.isError && !more.data) return void more.refetch();
    void more.fetchNextPage();
  };

  const back = (
    <button
      type="button"
      onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/video"))}
      className="-ml-2 mb-2 inline-flex min-h-[40px] items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-muted hover:text-text"
    >
      <ChevronLeft />
      {t("video.title")}
    </button>
  );

  if (q.isPending) {
    return (
      <div>
        {back}
        <GridSkeleton />
      </div>
    );
  }
  if (!c) {
    return (
      <div>
        {back}
        {isNotFound(q.error) ? <EmptyState>{t("video.web.channel_not_found")}</EmptyState> : <VideoError error={q.error} onRetry={() => void q.refetch()} />}
      </div>
    );
  }
  return (
    <div className="space-y-6" data-testid="video-channel-page">
      <div>
        {back}
        {c.banner && (
          <div className="-mx-4 mb-4 aspect-[6/1] overflow-hidden bg-surface-2 sm:mx-0 sm:rounded-2xl">
            <img src={c.banner} alt="" className="h-full w-full object-cover" />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-4">
          <ChannelAvatar name={c.name} src={c.avatar} size={72} />
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-1.5 text-xl font-bold sm:text-2xl" data-testid="video-channel-name">
              <span className="truncate">{c.name}</span>
              {c.verified && <CheckIcon className="shrink-0 text-base text-muted" />}
            </h1>
            <p className="text-sm text-muted">{f.subs(c.subscribers)}</p>
          </div>
          {profileId && <SubscribeButton channelId={c.id} subscribed={c.subscribed} className="w-full justify-center sm:w-auto" />}
        </div>
        {c.description.trim() && <p className="mt-3 line-clamp-3 whitespace-pre-line text-sm text-muted">{c.description}</p>}
      </div>
      <section>
        <h2 className="mb-3 text-lg font-bold">{t("video.videos")}</h2>
        {videos.length ? <VideoGrid items={videos} /> : <EmptyState>{t("video.empty.search")}</EmptyState>}
        {videos.length > 0 && <LoadMore hasMore={hasMore} loading={more.isFetching} error={more.isError ? more.error : null} onMore={loadMore} />}
      </section>
    </div>
  );
}

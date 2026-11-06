// «Видео» (/video): YouTube through the self-hosted Invidious. Tabs
// (?tab=): Подписки (the subscribed channels' feed + «Продолжить»), В тренде,
// Поиск (?q=, suggestions as you type, channels + videos, «Показать ещё»),
// Смотреть позже, История. Phone-first: tabs scroll horizontally, one card
// per row on phones, a grid from sm up.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useI18n } from "@martytv/ui";
import { PageTitle } from "../components";
import { CvVoiceOfAmerica } from "../catalog/CvLenin";
import { BookmarkIcon, CloseIcon, HistoryIcon, SearchIcon } from "../icons";
import { useActiveProfile } from "../watch/ActiveProfile";
import { appendUnique, parseTab, TABS, type VideoItem, type VideoTab } from "./logic";
import { useContinue, useFeed, useRemoveHistory, useSubscriptions, useSuggestions, useTrending, useVideoHistory, useVideoSearch, useWatchLater, useWatchLaterToggle, type VideoChannelRef } from "./queries";
import { ChannelAvatar, channelHref, EmptyState, GridSkeleton, LoadMore, SubscribeButton, VideoCard, VideoError, VideoGrid, VideoRow, useVideoFormat } from "./ui";

const TAB_LABEL = {
  subscriptions: "video.subscriptions",
  trending: "video.trending",
  search: "video.search",
  watch_later: "video.watch_later",
  history: "video.history",
} as const;

export function VideoPage() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const tab = params.has("q") ? "search" : parseTab(params.get("tab"));
  const setTab = (v: VideoTab) => setParams(v === "subscriptions" ? {} : { tab: v });

  return (
    <div className="space-y-5" data-testid="video-page">
      <CvVoiceOfAmerica />
      <PageTitle>{t("video.title")}</PageTitle>
      <div role="tablist" aria-label={t("video.title")} className="no-scrollbar -mx-4 -mt-3 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            data-testid={`video-tab-${id}`}
            className={`min-h-[40px] shrink-0 whitespace-nowrap rounded-full px-4 text-sm font-semibold transition ${
              tab === id ? "bg-text text-bg" : "bg-surface-2 text-text hover:bg-border"
            }`}
          >
            {t(TAB_LABEL[id])}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "subscriptions" && <SubscriptionsTab />}
        {tab === "trending" && <TrendingTab />}
        {tab === "search" && <SearchTab key={params.get("q") ?? ""} />}
        {tab === "watch_later" && <WatchLaterTab />}
        {tab === "history" && <HistoryTab />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Подписки

function SubscriptionsTab() {
  const { t } = useI18n();
  const feed = useFeed();
  const subs = useSubscriptions();
  const cont = useContinue();
  const items = useMemo(() => (feed.data?.pages ?? []).reduce<VideoItem[]>((acc, p) => appendUnique(acc, p.items), []), [feed.data]);
  const channels = subs.data ?? [];

  return (
    <div className="space-y-7">
      {(cont.data?.length ?? 0) > 0 && (
        <section data-testid="video-continue">
          <h2 className="mb-3 text-lg font-bold">{t("video.continue")}</h2>
          <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
            {cont.data!.map((v) => (
              <div key={v.id} className="w-64 shrink-0 sm:w-72">
                <VideoCard v={v} inRow />
              </div>
            ))}
          </div>
        </section>
      )}
      {channels.length > 0 && (
        <section data-testid="video-my-channels">
          <h2 className="mb-3 text-lg font-bold">{t("video.web.my_channels")}</h2>
          <div className="no-scrollbar -mx-4 flex gap-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
            {channels.map((c) => (
              <Link key={c.id} to={channelHref(c.id)} className="flex w-[72px] shrink-0 flex-col items-center gap-1.5 text-center" data-testid="video-sub-channel">
                <ChannelAvatar name={c.name} src={c.avatar} size={60} />
                <span className="line-clamp-2 w-full text-xs leading-tight">{c.name}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
      <section>
        {feed.isPending ? (
          <GridSkeleton />
        ) : feed.error && !feed.data ? (
          <VideoError error={feed.error} onRetry={() => void feed.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState>
            <p>{t("video.empty.subscriptions")}</p>
            <Link to="/video?tab=search" className="mt-3 inline-block font-semibold text-accent hover:underline">
              {t("video.search")}
            </Link>
          </EmptyState>
        ) : (
          <>
            {(channels.length > 0 || (cont.data?.length ?? 0) > 0) && <h2 className="mb-3 text-lg font-bold">{t("video.web.new_videos")}</h2>}
            <VideoGrid items={items} />
            <LoadMore
              hasMore={feed.hasNextPage}
              loading={feed.isFetchingNextPage}
              error={feed.isFetchNextPageError ? feed.error : null}
              onMore={() => void feed.fetchNextPage()}
            />
          </>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- В тренде

function TrendingTab() {
  const q = useTrending();
  if (q.isPending) return <GridSkeleton />;
  if (q.error) return <VideoError error={q.error} onRetry={() => void q.refetch()} />;
  return <VideoGrid items={q.data ?? []} />;
}

// ---------------------------------------------------------------- Поиск

function SearchTab() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [text, setText] = useState(q);
  const [focused, setFocused] = useState(false);
  const [typed, setTyped] = useState("");
  const input = useRef<HTMLInputElement>(null);
  // Debounced suggestions while typing.
  useEffect(() => {
    const id = setTimeout(() => setTyped(text.trim()), 200);
    return () => clearTimeout(id);
  }, [text]);
  const sugg = useSuggestions(focused && typed !== q ? typed : "");
  const suggestions = (focused && typed && typed !== q ? (sugg.data ?? []) : []).slice(0, 8);

  const run = (v: string) => {
    const s = v.trim();
    setFocused(false);
    input.current?.blur();
    setParams(s ? { tab: "search", q: s } : { tab: "search" });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(text);
  };

  return (
    <div className="space-y-6">
      <form onSubmit={submit} role="search" className="relative">
        <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-lg text-muted" />
        <input
          ref={input}
          type="search"
          enterKeyHint="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder={t("video.search_placeholder")}
          aria-label={t("video.search_placeholder")}
          autoFocus={!q}
          maxLength={150}
          data-testid="video-search-input"
          className="min-h-[48px] w-full rounded-full border border-border bg-surface pl-11 pr-11 text-base outline-none focus:border-accent"
        />
        {text && (
          <button
            type="button"
            onClick={() => {
              setText("");
              input.current?.focus();
            }}
            aria-label={t("video.web.clear_search")}
            className="absolute right-1.5 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:text-text"
          >
            <CloseIcon />
          </button>
        )}
        {suggestions.length > 0 && (
          <ul role="listbox" className="absolute inset-x-0 top-full z-20 mt-1.5 overflow-hidden rounded-2xl border border-border bg-surface py-1 shadow-2xl shadow-black/40" data-testid="video-suggestions">
            {suggestions.map((s) => (
              <li key={s} role="option" aria-selected={false}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setText(s);
                    run(s);
                  }}
                  className="flex min-h-[44px] w-full items-center gap-3 px-4 text-left hover:bg-surface-2"
                  data-testid="video-suggestion"
                >
                  <SearchIcon className="shrink-0 text-muted" />
                  <span className="truncate">{s}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </form>
      {q ? <SearchResults q={q} /> : <p className="text-center text-muted">{t("video.web.search_hint")}</p>}
    </div>
  );
}

function SearchResults({ q }: { q: string }) {
  const { t } = useI18n();
  const res = useVideoSearch(q);
  const { videos, channels } = useMemo(() => {
    let videos: VideoItem[] = [];
    const channels: VideoChannelRef[] = [];
    for (const p of res.data?.pages ?? []) {
      videos = appendUnique(videos, p.videos);
      for (const c of p.channels) if (!channels.some((x) => x.id === c.id)) channels.push(c);
    }
    return { videos, channels };
  }, [res.data]);

  if (res.isPending) return <GridSkeleton />;
  if (res.error && !res.data) return <VideoError error={res.error} onRetry={() => void res.refetch()} />;
  if (!videos.length && !channels.length) return <EmptyState icon={<SearchIcon />}>{t("video.empty.search")}</EmptyState>;
  return (
    <div className="space-y-7" data-testid="video-search-results">
      {channels.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-bold">{t("video.web.channels")}</h2>
          {channels.slice(0, 3).map((c) => (
            <ChannelLine key={c.id} c={c} />
          ))}
        </section>
      )}
      {videos.length > 0 && <VideoGrid items={videos} />}
      <LoadMore
        hasMore={res.hasNextPage}
        loading={res.isFetchingNextPage}
        error={res.isFetchNextPageError ? res.error : null}
        onMore={() => void res.fetchNextPage()}
      />
    </div>
  );
}

function ChannelLine({ c }: { c: VideoChannelRef }) {
  const f = useVideoFormat();
  const { profileId } = useActiveProfile();
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-3" data-testid="video-channel-result">
      <Link to={channelHref(c.id)} className="flex min-w-0 flex-1 items-center gap-3">
        <ChannelAvatar name={c.name} src={c.avatar} size={52} />
        <span className="min-w-0">
          <span className="block truncate font-semibold">{c.name}</span>
          <span className="block truncate text-xs text-muted">{f.subs(c.subscribers)}</span>
        </span>
      </Link>
      {profileId && <SubscribeButton channelId={c.id} subscribed={c.subscribed} />}
    </div>
  );
}

// ---------------------------------------------------------------- lists

function RemoveButton({ label, onClick, testId }: { label: string; onClick: () => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
      className="-mr-2 -mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-text"
    >
      <CloseIcon />
    </button>
  );
}

function WatchLaterTab() {
  const { t } = useI18n();
  const q = useWatchLater();
  const toggle = useWatchLaterToggle();
  if (q.isPending) return <GridSkeleton />;
  if (q.error) return <VideoError error={q.error} onRetry={() => void q.refetch()} />;
  const items = q.data ?? [];
  if (!items.length) return <EmptyState icon={<BookmarkIcon />}>{t("video.empty.watch_later")}</EmptyState>;
  return (
    <VideoGrid
      items={items}
      action={(v) => <RemoveButton label={t("video.remove_watch_later")} testId="video-remove-later" onClick={() => toggle.mutate({ videoId: v.id, on: false })} />}
    />
  );
}

function HistoryTab() {
  const { t } = useI18n();
  const q = useVideoHistory();
  const remove = useRemoveHistory();
  if (q.isPending) return <GridSkeleton />;
  if (q.error) return <VideoError error={q.error} onRetry={() => void q.refetch()} />;
  const items = q.data ?? [];
  if (!items.length) return <EmptyState icon={<HistoryIcon />}>{t("video.empty.history")}</EmptyState>;
  return (
    <div className="space-y-4" data-testid="video-history">
      {items.map((v) => (
        <div key={v.id} className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <VideoRow v={v} />
          </div>
          <RemoveButton label={t("video.web.remove_history")} testId="video-remove-history" onClick={() => remove.mutate(v.id)} />
        </div>
      ))}
    </div>
  );
}

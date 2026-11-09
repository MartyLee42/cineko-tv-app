import { useEffect, useRef, useState } from "react";
import { NoteCard } from "../foryou/NoteCard";
import { Link, useParams, useSearchParams } from "react-router";
import type { Episode, MediaDetail, Schemas, WatchProgress } from "@martytv/contracts";
import { countryList, formatDate, formatRuntime, imageUrl, episodeCode, placeholderColor, formatRating } from "@martytv/media-types";
import { GenreReaction, useI18n, type MessageKey, ratingTone } from "@martytv/ui";
import { BellIcon, CheckIcon, PlayIcon } from "../icons";
import { Backdrop, CatalogError, CatalogPage, Img, Poster, PosterRow } from "../catalog/components";
import { isNotFound, useCatalogConfig, useMedia, useRelated, useSeason } from "../catalog/queries";
import { defaultSeason, orderSeasons } from "../catalog/seasons";
import { SendToTvButton, SendToTvProvider } from "../remote/SendToTv";
import { NowOnTvChip } from "../remote/NowOnTv";
import { EpisodePlayButtons, PlayOnTvProvider } from "../play/PlayOnTv";
import { PlayChooser } from "../play/PlayChooser";
import { useActiveProfile } from "../watch/ActiveProfile";
import { ListToggles, ProgressBar, RatePrompt, TOOL_BTN, TOOL_LABEL, TOOL_OFF } from "../watch/components";
import { episodeProgressMap, formatClock, formatLeft, resumeState, seasonProgress } from "../watch/format";
import { useMediaProgress, useSetWatched, useSettings } from "../watch/queries";
import { useFilmTheme } from "../filmtheme/useFilmTheme";
import { RecommendButton } from "../reco/RecommendButton";
import { FamilyRatings } from "../family/Family";
import { OnlineWatchButton } from "../play/OnlineWatch";
import { DownloadChip, useNow } from "../downloads/ui";
import { SaveEpisodeButton, SaveSeasonButton } from "../offline/ui";
import { initials } from "../catalog/person";
import { CvQueue } from "../catalog/CvExtras";
import { Awards } from "../catalog/Awards";
import { TriviaButtons } from "../catalog/Trivia";
import { CompanionButtons } from "../catalog/Companion";
import { SoundtrackButton } from "../catalog/Soundtrack";
import { useMutedSeries, useMuteSeries } from "../newepisodes/queries";

type Video = Schemas["Video"];
type CastMember = Schemas["CastMember"];

export function TitlePage() {
  const { id = "" } = useParams();
  return (
    <CatalogPage>
      {/* key: reset per-title state (trailer, season) when navigating between titles */}
      <Title key={id} id={id} />
      <CvQueue key={`q-${id}`} id={id} />
    </CatalogPage>
  );
}

function Title({ id }: { id: string }) {
  const { t } = useI18n();
  const media = useMedia(id);

  if (media.isPending) return <DetailSkeleton />;
  if (media.error) {
    if (isNotFound(media.error)) {
      return (
        <div className="py-20 text-center" data-testid="title-not-found">
          <p className="text-lg text-muted">{t("catalog.detail.not_found")}</p>
          <Link to="/" className="mt-4 inline-flex min-h-[44px] items-center rounded-xl bg-surface-2 px-4 font-semibold">
            {t("nav.home")}
          </Link>
        </div>
      );
    }
    return <CatalogError error={media.error} onRetry={() => media.refetch()} />;
  }
  const m = media.data;

  return (
    <SendToTvProvider>
      <PlayOnTvProvider>
      <article className="space-y-10">
        <div className="space-y-4">
          <Hero m={m} />
          <Extras m={m} />
        </div>
        <RatePrompt only={m.id} />
        <div className="grid gap-10 lg:grid-cols-[1fr_18rem]">
          <div className="min-w-0 space-y-10">
            <Overview m={m} />
            <Awards m={m} />
            <NoteCard m={m} />
            {m.trailer && <Trailer video={m.trailer} backdrop={m.backdrop_path} title={m.title} />}
            {m.kind === "series" && m.seasons.length > 0 && <Seasons m={m} />}
          </div>
          <aside className="space-y-8">
            <Facts m={m} />
          </aside>
        </div>
        <Cast cast={m.cast} />
        <Related id={m.id} which="recommendations" />
        <Related id={m.id} which="similar" />
      </article>
      </PlayOnTvProvider>
    </SendToTvProvider>
  );
}

function Hero({ m }: { m: MediaDetail }) {
  const { t, locale } = useI18n();
  // «Тема под фильм»: the hero takes the film's look once its chunk is here.
  const filmTheme = useFilmTheme(m);
  const runtime = formatRuntime(m.runtime, locale);
  const meta = [
    m.year,
    t(`catalog.kind.${m.kind}` as MessageKey),
    m.kind === "series"
      ? m.number_of_seasons
        ? t("catalog.detail.seasons_count", { n: m.number_of_seasons })
        : null
      : runtime,
    m.kind === "series" && m.number_of_episodes ? t("catalog.detail.episodes_count", { n: m.number_of_episodes }) : null,
    countryList(m.countries, locale),
  ].filter(Boolean);

  return (
    <section data-film-theme={filmTheme ?? undefined} className="relative -mx-4 -mt-6 overflow-hidden sm:mx-0 sm:mt-0 sm:rounded-3xl">
      <Backdrop path={m.backdrop_path} title={m.title} eager />
      <div className="relative flex flex-col gap-5 px-4 pb-6 pt-40 sm:flex-row sm:items-end sm:gap-8 sm:px-10 sm:pb-10 sm:pt-56">
        <Poster
          item={m}
          eager
          sizes="(min-width: 640px) 208px, 128px"
          className="w-32 shrink-0 shadow-2xl shadow-black/40 ring-1 ring-black/10 sm:w-52"
        />
        <div className="min-w-0 space-y-3">
          <h1 className="text-3xl font-extrabold leading-tight drop-shadow sm:text-5xl">{m.title}</h1>
          {m.original_title && m.original_title !== m.title && (
            <p className="text-sm text-muted">
              <span className="sr-only">{t("catalog.detail.original_title")}: </span>
              {m.original_title}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text/85">
            <RatingChips m={m} />
            {meta.map((x, i) => (
              <span key={i} className="flex items-center gap-2">
                {(i > 0 || m.rating != null || m.kp_rating != null || m.imdb_rating != null) && <span aria-hidden className="text-text/40">·</span>}
                {x}
              </span>
            ))}
          </div>
          {m.genres.length > 0 && (
            <div className="flex items-center gap-3">
            <ul className="flex flex-wrap gap-1.5" aria-label={t("catalog.detail.genres")}>
              {m.genres.map((g) => (
                <li key={g.id}>
                  <Link
                    to={`/browse?kind=${m.kind}&genres=${g.id}`}
                    className="inline-flex min-h-[32px] items-center rounded-full border border-border bg-surface/60 px-3 text-xs font-medium backdrop-blur hover:border-accent"
                  >
                    {g.name}
                  </Link>
                </li>
              ))}
            </ul>
            {/* Cineko reacts to the genre (hides from horror, laughs, gets misty). */}
            <GenreReaction genres={m.genres} size={64} />
            </div>
          )}
          {m.kind === "movie" ? <MovieActions m={m} /> : <SeriesActions m={m} />}
          <MyToolbar m={m} />
          <FamilyRatings mediaId={m.id} />
        </div>
      </div>
    </section>
  );
}

/** Under the play button: «● Сейчас на Almaty · Пульт» and a server download's status, when there are any. */
function StatusLine({ mediaId }: { mediaId: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 [&:empty]:hidden">
      <NowOnTvChip mediaId={mediaId} />
      <DownloadChip mediaId={mediaId} />
    </div>
  );
}

function MovieActions({ m }: { m: MediaDetail }) {
  const { t, locale } = useI18n();
  const { data: cfg } = useCatalogConfig();
  const progress = useMediaProgress(m.id).data;
  const rs = resumeState(progress?.movie);
  const movie = progress?.movie;
  const target = { media_id: m.id, label: m.title };
  const left = movie && rs.kind === "resume" ? formatLeft(movie, locale) : null;
  return (
    <div className="space-y-3 pt-2">
      {rs.kind === "resume" && (
        <div className="max-w-sm space-y-1" data-testid="movie-progress">
          <ProgressBar value={rs.percent} label={t("watch.resume_at", { time: formatClock(rs.position) })} />
          {left && <p className="text-xs text-muted">{t("watch.left", { time: left })}</p>}
        </div>
      )}
      <PlayChooser
        m={m}
        className="w-full sm:w-auto"
        target={rs.kind === "resume" ? { ...target, position_seconds: rs.position } : rs.kind === "again" ? { ...target, position_seconds: 0 } : target}
        label={
          rs.kind === "resume"
            ? t("watch.resume_at", { time: formatClock(rs.position) })
            : rs.kind === "again"
              ? t("watch.watch_again")
              : t("player.play")
        }
        resumeTime={rs.kind === "resume" ? formatClock(rs.position) : undefined}
        releases
        save={{ media_id: m.id, title: m.title, poster: imageUrl(cfg, m.poster_path, "w342") }}
      />
      <StatusLine mediaId={m.id} />
    </div>
  );
}

function SeriesActions({ m }: { m: MediaDetail }) {
  const { t } = useI18n();
  const progress = useMediaProgress(m.id).data;
  const next = progress?.next_up ?? null;
  const epProgress = next ? episodeProgressMap(progress).get(next.episode_id) : undefined;
  const rs = resumeState(epProgress);
  const code = next ? episodeCode(next.season_number, next.episode_number) : "";
  // Never started: offer the first episode (torrents, online, TV) instead of
  // only «Смотреть онлайн».
  const firstSeason = next ? null : firstRegularSeason(m.seasons);
  const first = useSeason(m.id, firstSeason).data?.episodes?.find((e) => e.season_number === firstSeason) ?? null;
  const firstCode = first ? episodeCode(first.season_number, first.episode_number) : "";
  return (
    <div className="space-y-3 pt-2">
      {next ? (
        <PlayChooser
          m={m}
          testId="play-next-up"
          className="w-full sm:w-auto"
          target={{
            media_id: m.id,
            season_number: next.season_number,
            episode_number: next.episode_number,
            episode_id: next.episode_id,
            label: `${m.title} · ${code}`,
            detail: next.name,
            ...(rs.kind === "resume" && { position_seconds: rs.position }),
          }}
          label={rs.kind === "resume" ? `${code} · ${t("watch.resume_at", { time: formatClock(rs.position) })}` : t("watch.next_up", { code })}
          resumeTime={rs.kind === "resume" ? formatClock(rs.position) : undefined}
          releases
        />
      ) : first ? (
        <PlayChooser
          m={m}
          testId="play-first"
          className="w-full sm:w-auto"
          target={{
            media_id: m.id,
            season_number: first.season_number,
            episode_number: first.episode_number,
            episode_id: first.id,
            label: `${m.title} · ${firstCode}`,
            detail: first.name,
          }}
          label={`${t("player.play")} · ${firstCode}`}
          releases
        />
      ) : (
        // Nothing to continue: episodes play from the list below; online / open on TV stay here.
        <div className="flex flex-wrap items-center gap-3">
          <OnlineWatchButton m={m} className="w-full sm:w-auto" />
          <SendToTvButton target={{ media_id: m.id }} className="w-full sm:w-auto" />
        </div>
      )}
      <StatusLine mediaId={m.id} />
    </div>
  );
}

/** The first regular season with episodes (season 1 for most shows), else specials. */
function firstRegularSeason(seasons: MediaDetail["seasons"]): number | null {
  const list = seasons ?? [];
  const regular = list.filter((x) => x.season_number > 0 && x.episode_count > 0).sort((a, b) => a.season_number - b.season_number);
  return regular[0]?.season_number ?? list.find((x) => x.episode_count > 0)?.season_number ?? null;
}

/** Personal marks, small: «Буду смотреть», ♥, ★ rating, «Посоветовать», «Просмотрено» (movies). */
function MyToolbar({ m }: { m: MediaDetail }) {
  const { t } = useI18n();
  const { profileId } = useActiveProfile();
  const progress = useMediaProgress(m.id).data;
  const setWatched = useSetWatched(m.id);
  const movie = progress?.movie;
  return (
    <div role="group" aria-label={t("titleactions.mine")} className="flex flex-wrap items-center gap-2" data-testid="title-toolbar">
      <ListToggles m={m} compact />
      {profileId && m.kind === "movie" && (
        <WatchedButton watched={!!movie?.completed} busy={setWatched.isPending} onToggle={() => setWatched.mutate({ watched: !movie?.completed })} />
      )}
      {profileId && m.kind === "series" && <NewEpisodesToggle mediaId={m.id} />}
      <RecommendButton m={m} compact />
    </div>
  );
}

/** Series: «Новые серии» on/off for this profile (muted series are skipped by the nightly check). */
function NewEpisodesToggle({ mediaId }: { mediaId: string }) {
  const { t } = useI18n();
  const muted = useMutedSeries();
  const mute = useMuteSeries();
  if (!muted.data) return null;
  const on = !muted.data.items.some((it) => it.media.id === mediaId);
  const hint = on ? t("newepmute.toggle_on") : t("newepmute.toggle_off");
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={hint}
      title={hint}
      disabled={mute.isPending}
      onClick={() => mute.mutate({ mediaId, on })}
      data-testid="toggle-new-episodes"
      className={`${TOOL_BTN} disabled:opacity-60 ${on ? TOOL_OFF : "border-border bg-surface/70 text-muted line-through hover:border-accent"}`}
    >
      <BellIcon off={!on} className="text-lg" />
      <span className={TOOL_LABEL}>{t("newepmute.toggle")}</span>
    </button>
  );
}

/** «Дополнительно» under the hero: recap, after credits, facts, quotes, soundtrack (each keeps its own rules). */
function Extras({ m }: { m: MediaDetail }) {
  const { t } = useI18n();
  return (
    <section aria-label={t("titleactions.extras")} data-testid="title-extras" className="flex items-center gap-3">
      <span aria-hidden className="hidden shrink-0 text-xs font-semibold uppercase tracking-wider text-muted sm:block">{t("titleactions.extras")}</span>
      <div className="no-scrollbar -mx-4 flex min-w-0 flex-1 gap-2 overflow-x-auto px-4 py-0.5 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
        <CompanionButtons m={m} />
        <TriviaButtons m={m} />
        <SoundtrackButton m={m} />
      </div>
    </section>
  );
}

function WatchedButton({ watched, busy, onToggle }: { watched: boolean; busy: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const label = watched ? t("watch.watched") : t("watch.mark_watched");
  return (
    <button
      type="button"
      aria-pressed={watched}
      disabled={busy}
      onClick={onToggle}
      title={label}
      data-testid="toggle-watched"
      className={`${TOOL_BTN} disabled:opacity-60 ${watched ? "border-ok/60 bg-ok/15 text-ok" : TOOL_OFF}`}
    >
      <CheckIcon className="text-lg" />
      <span className={TOOL_LABEL}>{watched ? t("watch.watched") : t("watch.watched")}</span>
    </button>
  );
}

function Overview({ m }: { m: MediaDetail }) {
  const { t } = useI18n();
  const crew = keyCrew(m);
  return (
    <section className="space-y-4">
      {m.tagline && <p className="text-lg italic text-text/80">“{m.tagline}”</p>}
      <h2 className="text-xl font-bold">{t("catalog.detail.overview")}</h2>
      <p className="max-w-3xl leading-relaxed text-text/90" data-testid="title-overview">
        {m.overview || t("catalog.detail.no_overview")}
      </p>
      {crew.length > 0 && (
        <dl className="grid grid-cols-1 gap-x-8 gap-y-3 pt-2 sm:grid-cols-3">
          {crew.map(([label, names]) => (
            <div key={label}>
              <dt className="text-xs font-semibold uppercase tracking-wider text-muted">{t(label)}</dt>
              <dd className="mt-0.5 text-sm">
                {names.map((n, i) => (
                  <span key={n.id}>
                    {i > 0 && ", "}
                    <Link to={`/person/${n.id}`} className="hover:text-accent-strong hover:underline" data-testid="crew-link">
                      {n.name}
                    </Link>
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/** Directors / creators / writers, deduplicated, at most 3 names each. */
function keyCrew(m: MediaDetail): [MessageKey, { id: number; name: string }[]][] {
  const pick = (jobs: string[]) => {
    const seen = new Set<number>();
    return m.crew
      .filter((c) => jobs.includes(c.job) && !seen.has(c.person_tmdb_id) && seen.add(c.person_tmdb_id))
      .map((c) => ({ id: c.person_tmdb_id, name: c.name }))
      .slice(0, 3);
  };
  const out: [MessageKey, { id: number; name: string }[]][] = [
    ["catalog.detail.director", pick(["Director"])],
    ["catalog.detail.creator", pick(["Creator"])],
    ["catalog.detail.writer", pick(["Screenplay", "Writer", "Novel", "Story"])],
  ];
  return out.filter(([, names]) => names.length > 0);
}

function Facts({ m }: { m: MediaDetail }) {
  const { t, locale } = useI18n();
  const rows: [string, string | null][] = [
    [t(m.kind === "movie" ? "catalog.detail.released" : "catalog.detail.first_aired"), formatDate(m.release_date, locale)],
    [t("catalog.detail.runtime"), formatRuntime(m.runtime, locale)],
    [t("catalog.detail.status"), m.status || null],
    [t("catalog.detail.original_title"), m.original_title !== m.title ? m.original_title : null],
  ];
  const shown = rows.filter((r): r is [string, string] => !!r[1]);
  if (!shown.length) return null;
  return (
    <dl className="space-y-3 rounded-2xl border border-border bg-surface p-4 text-sm">
      {shown.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs font-semibold uppercase tracking-wider text-muted">{k}</dt>
          <dd className="mt-0.5">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Tap-to-load trailer: no third-party iframe until the user asks for it. */
function Trailer({ video, backdrop, title }: { video: Video; backdrop: string | null; title: string }) {
  const { t } = useI18n();
  const { data: cfg } = useCatalogConfig();
  const [playing, setPlaying] = useState(false);
  const src =
    video.site === "YouTube"
      ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.key)}?autoplay=1&rel=0`
      : `https://player.vimeo.com/video/${encodeURIComponent(video.key)}?autoplay=1&dnt=1`;

  return (
    <section className="space-y-3">
      <h2 className="text-xl font-bold">{t("catalog.detail.trailer")}</h2>
      <div className="relative aspect-video max-w-3xl overflow-hidden rounded-2xl bg-surface-2">
        {playing ? (
          <iframe
            src={src}
            title={video.name || `${title} — ${t("catalog.detail.trailer")}`}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            className="absolute inset-0 h-full w-full"
          />
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            className="group absolute inset-0 flex items-center justify-center"
            style={{ background: placeholderColor(title) }}
          >
            <Img
              src={imageUrl(cfg, backdrop, "w780")}
              alt=""
              className="absolute inset-0 h-full w-full object-cover opacity-70 transition group-hover:opacity-90"
              fallback={null}
            />
            <span className="relative flex items-center gap-3 rounded-full bg-black/70 py-3 pl-4 pr-5 font-semibold text-white backdrop-blur transition group-hover:bg-accent group-hover:text-on-accent">
              <PlayIcon className="text-xl" />
              {t("catalog.detail.play_trailer")}
            </span>
          </button>
        )}
      </div>
    </section>
  );
}

function Seasons({ m }: { m: MediaDetail }) {
  const { t, locale } = useI18n();
  const [params, setParams] = useSearchParams();
  const { profileId } = useActiveProfile();
  const settings = useSettings();
  const progress = useMediaProgress(m.id).data;
  const setWatched = useSetWatched(m.id);
  const seasons = orderSeasons(m.seasons);
  const fromUrl = Number(params.get("season"));
  const nextUp = progress?.next_up ?? null;
  const selected =
    params.get("season") != null && seasons.some((s) => s.season_number === fromUrl)
      ? fromUrl
      : nextUp && seasons.some((s) => s.season_number === nextUp.season_number)
        ? nextUp.season_number
        : defaultSeason(seasons);
  const focusEpisode = params.get("season") != null ? Number(params.get("episode")) || null : null;
  const season = useSeason(m.id, selected);
  const select = (n: number) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("season", String(n));
        next.delete("episode");
        return next;
      },
      { replace: true },
    );
  const label = (n: number) => (n === 0 ? t("catalog.detail.specials") : t("catalog.detail.season", { n }));
  const episodes = season.data?.episodes;
  const byEpisode = episodeProgressMap(progress);
  const sp = selected != null ? seasonProgress(progress, selected) : null;
  const { data: cfg } = useCatalogConfig();
  const poster = imageUrl(cfg, m.poster_path, "w342");
  const now = useNow();

  // Arriving from "Continue watching": bring the episode into view once.
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || !focusEpisode || !episodes?.length || season.isPlaceholderData) return;
    focused.current = true;
    document.getElementById(`ep-${selected}-${focusEpisode}`)?.scrollIntoView({ block: "center" });
  }, [episodes, focusEpisode, selected, season.isPlaceholderData]);

  return (
    <section className="space-y-4" data-testid="seasons">
      <h2 className="text-xl font-bold">{t("catalog.detail.episodes")}</h2>
      <div role="tablist" aria-label={t("catalog.detail.seasons")} className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
        {seasons.map((s) => {
          const on = s.season_number === selected;
          const p = seasonProgress(progress, s.season_number);
          return (
            <button
              key={s.season_number}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => select(s.season_number)}
              className={`flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold transition ${
                on ? "border-accent bg-accent text-on-accent" : "border-border bg-surface text-text/85 hover:border-muted"
              }`}
            >
              {label(s.season_number)}
              {p?.complete ? (
                <CheckIcon aria-label={t("watch.watched")} className={on ? "" : "text-ok"} />
              ) : p && p.done > 0 ? (
                <span className={`text-xs font-medium ${on ? "text-on-accent/70" : "text-muted"}`}>
                  {p.done}/{p.total}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {profileId && selected != null && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="season-progress">
          {sp && (
            <div className="min-w-[10rem] flex-1 space-y-1 sm:max-w-xs">
              <p className="text-sm text-muted">{t("watch.season_progress", { done: sp.done, total: sp.total })}</p>
              <ProgressBar value={sp.ratio} />
            </div>
          )}
          {!!episodes?.length && (
            <button
              type="button"
              data-testid="season-watched"
              disabled={setWatched.isPending}
              onClick={() =>
                setWatched.mutate({ watched: !sp?.complete, season_number: selected, episodes: episodes.map(epRef) })
              }
              className="ml-auto inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-border bg-surface px-3.5 text-sm font-semibold transition hover:border-accent disabled:opacity-60"
            >
              <CheckIcon className={sp?.complete ? "text-ok" : "text-muted"} />
              {sp?.complete ? t("watch.mark_season_unwatched") : t("watch.mark_season_watched")}
            </button>
          )}
        </div>
      )}

      {!!episodes?.length && !season.isPlaceholderData && (
        <SaveSeasonButton
          mediaId={m.id}
          title={m.title}
          poster={poster}
          // Not aired yet: nothing to download.
          episodes={episodes.filter((e) => !e.air_date || Date.parse(e.air_date) <= now).map((e) => ({ ...epRef(e), name: e.name, code: episodeCode(e.season_number, e.episode_number) }))}
        />
      )}

      {season.isPending ? (
        <ul className="space-y-3">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="h-24 animate-pulse rounded-2xl bg-surface" />
          ))}
        </ul>
      ) : season.error && !season.data ? (
        <CatalogError error={season.error} onRetry={() => season.refetch()} />
      ) : episodes?.length ? (
        <ol className={`space-y-3 transition-opacity ${season.isPlaceholderData ? "opacity-50" : ""}`} data-testid="episodes">
          {episodes.map((e) => {
            const ep = byEpisode.get(e.id);
            return (
              <EpisodeRow
                key={e.id}
                e={e}
                mediaId={m.id}
                title={m.title}
                poster={poster}
                locale={locale}
                fallbackTitle={t("catalog.detail.episode", { n: e.episode_number })}
                progress={ep}
                nextUp={nextUp?.episode_id === e.id}
                focused={focusEpisode === e.episode_number && selected === e.season_number}
                spoiler={settings.spoiler_free_episodes && !ep?.completed}
                onWatched={
                  profileId
                    ? () => setWatched.mutate({ watched: !ep?.completed, episode_id: e.id, episodes: [epRef(e)] })
                    : undefined
                }
              />
            );
          })}
        </ol>
      ) : (
        <p className="py-6 text-center text-muted">{t("catalog.detail.no_episodes")}</p>
      )}
    </section>
  );
}

const epRef = (e: Episode) => ({ id: e.id, season_number: e.season_number, episode_number: e.episode_number });

function EpisodeRow({
  e,
  mediaId,
  title,
  locale,
  fallbackTitle,
  progress,
  nextUp,
  focused,
  spoiler,
  onWatched,
  poster,
}: {
  e: Episode;
  mediaId: string;
  title: string;
  poster: string | null;
  locale: string;
  fallbackTitle: string;
  progress: WatchProgress | undefined;
  nextUp: boolean;
  focused: boolean;
  spoiler: boolean;
  onWatched?: () => void;
}) {
  const { t } = useI18n();
  const { data: cfg } = useCatalogConfig();
  const [revealed, setRevealed] = useState(false);
  const hide = spoiler && !revealed;
  const name = e.name || fallbackTitle;
  const code = episodeCode(e.season_number, e.episode_number);
  const watched = !!progress?.completed;
  const rs = resumeState(progress);
  const left = progress && rs.kind === "resume" ? formatLeft(progress, locale) : null;
  const meta = [
    formatDate(e.air_date, locale),
    formatRuntime(e.runtime, locale),
    left && t("watch.left", { time: left }),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li
      id={`ep-${e.season_number}-${e.episode_number}`}
      data-testid="episode-row"
      data-watched={watched || undefined}
      data-next-up={nextUp || undefined}
      className={`flex scroll-mt-24 gap-3 rounded-2xl border bg-surface p-2.5 sm:gap-4 sm:p-3 ${
        nextUp || focused ? "border-accent/70 ring-1 ring-accent/40" : "border-border"
      }`}
    >
      <div
        className="relative aspect-video w-32 shrink-0 self-start overflow-hidden rounded-xl sm:w-44"
        style={{ background: placeholderColor(name) }}
      >
        <Img
          src={imageUrl(cfg, e.still_path, "w300")}
          alt={hide ? "" : name}
          className={`absolute inset-0 h-full w-full object-cover transition ${hide ? "scale-110 blur-lg" : ""} ${watched ? "opacity-70" : ""}`}
          fallback={<span className="absolute inset-0 flex items-center justify-center font-mono text-xs text-white/60">{code}</span>}
        />
        {watched && (
          <span className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-sm text-on-accent shadow">
            <CheckIcon strokeWidth={3} />
          </span>
        )}
        {rs.kind === "resume" && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/45">
            <div className="h-full bg-accent" style={{ width: `${Math.round(rs.percent * 100)}%` }} />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 py-0.5">
        <p className="flex flex-wrap items-center gap-x-2 font-mono text-xs font-semibold text-accent">
          {code}
          {nextUp && (
            <span className="rounded bg-accent px-1.5 py-px font-sans text-[10px] font-bold uppercase tracking-wider text-on-accent">
              {t("watch.next_up_badge")}
            </span>
          )}
        </p>
        <h3 className="mt-0.5 line-clamp-2 font-semibold leading-snug" data-testid="episode-name">{name}</h3>
        {meta && <p className="mt-0.5 text-xs text-muted">{meta}</p>}
        <DownloadChip mediaId={mediaId} episode={{ episode_id: e.id, season_number: e.season_number, episode_number: e.episode_number }} className="mt-1.5" />
        <SaveEpisodeButton
          code={code}
          target={{
            media_id: mediaId,
            episode_id: e.id,
            season_number: e.season_number,
            episode_number: e.episode_number,
            title,
            subtitle: [code, e.name].filter(Boolean).join(" · "),
            poster,
          }}
        />
        {e.overview &&
          (hide ? (
            <button
              type="button"
              onClick={() => setRevealed(true)}
              className="mt-1.5 block text-left"
              title={t("watch.reveal_spoiler")}
              data-testid="spoiler-hidden"
            >
              <span aria-hidden className="line-clamp-2 select-none text-sm leading-snug text-text/75 blur-[5px]">
                {e.overview}
              </span>
              <span className="sr-only">{t("watch.reveal_spoiler")}</span>
            </button>
          ) : (
            <p className="mt-1.5 line-clamp-2 text-sm leading-snug text-text/75 sm:line-clamp-3">{e.overview}</p>
          ))}
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1.5 self-center">
        <EpisodePlayButtons
          code={code}
          target={{
            media_id: mediaId,
            season_number: e.season_number,
            episode_number: e.episode_number,
            episode_id: e.id,
            label: `${title} · ${code}`,
            detail: name,
            ...(rs.kind === "resume" && { position_seconds: rs.position }),
          }}
        />
        {onWatched && (
          <button
            type="button"
            aria-pressed={watched}
            aria-label={`${watched ? t("watch.mark_unwatched") : t("watch.mark_watched")} ${code}`}
            title={watched ? t("watch.mark_unwatched") : t("watch.mark_watched")}
            data-testid="episode-watched"
            onClick={onWatched}
            className={`flex h-9 w-9 items-center justify-center rounded-full border text-base transition ${
              watched ? "border-ok/60 bg-ok/15 text-ok" : "border-border bg-surface-2 text-muted hover:border-accent hover:text-accent"
            }`}
          >
            <CheckIcon />
          </button>
        )}
      </div>
    </li>
  );
}

function Cast({ cast }: { cast: CastMember[] }) {
  const { t } = useI18n();
  const { data: cfg } = useCatalogConfig();
  if (!cast.length) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-bold">{t("catalog.detail.cast")}</h2>
      <ul className="no-scrollbar -mx-4 flex snap-x gap-3 overflow-x-auto scroll-px-4 px-4 pb-1 md:mx-0 md:scroll-px-0 md:px-0">
        {[...cast]
          .sort((a, b) => a.order - b.order)
          .slice(0, 20)
          .map((c) => (
            <li key={`${c.person_tmdb_id}-${c.character}`} className="w-24 shrink-0 snap-start text-center sm:w-28">
              <Link to={`/person/${c.person_tmdb_id}`} className="group block outline-none" data-testid="cast-link" title={t("catalog.person.open", { name: c.name })}>
              <div
                className="relative mx-auto aspect-square w-full overflow-hidden rounded-full transition group-hover:ring-2 group-hover:ring-accent group-focus-visible:ring-2 group-focus-visible:ring-accent"
                style={{ background: placeholderColor(c.name) }}
              >
                <Img
                  src={imageUrl(cfg, c.profile_path, "w185")}
                  alt={c.name}
                  className="absolute inset-0 h-full w-full object-cover"
                  fallback={
                    <span className="absolute inset-0 flex items-center justify-center text-xl font-bold text-white/80">
                      {initials(c.name)}
                    </span>
                  }
                />
              </div>
              <p className="mt-2 line-clamp-2 text-sm font-medium leading-tight group-hover:text-accent-strong">{c.name}</p>
              {c.character && <p className="mt-0.5 line-clamp-2 text-xs leading-tight text-muted">{c.character}</p>}
              </Link>
            </li>
          ))}
      </ul>
    </section>
  );
}

function Related({ id, which }: { id: string; which: "similar" | "recommendations" }) {
  const { t } = useI18n();
  const { data, isPending } = useRelated(id, which);
  return (
    <PosterRow
      title={t(which === "similar" ? "catalog.detail.similar" : "catalog.detail.recommendations")}
      items={data}
      loading={isPending}
    />
  );
}

function DetailSkeleton() {
  return (
    <div aria-busy className="space-y-8">
      <div className="relative -mx-4 -mt-6 h-[420px] animate-pulse bg-surface sm:mx-0 sm:mt-0 sm:h-[480px] sm:rounded-3xl" />
      <div className="space-y-3">
        <div className="h-5 w-40 animate-pulse rounded bg-surface" />
        <div className="h-4 w-full max-w-2xl animate-pulse rounded bg-surface" />
        <div className="h-4 w-full max-w-xl animate-pulse rounded bg-surface" />
      </div>
    </div>
  );
}

/** All known ratings: «КП 7.4 · IMDb 6.9 · TMDB 6.0», coloured by score. */
function RatingChips({ m }: { m: MediaDetail }) {
  const { t, locale } = useI18n();
  const items = [
    { key: "kp", label: "КП", value: m.kp_rating },
    { key: "imdb", label: "IMDb", value: m.imdb_rating },
    { key: "tmdb", label: "TMDB", value: m.rating },
  ].filter((x): x is { key: string; label: string; value: number } => x.value != null && x.value > 0);
  if (!items.length) return null;
  const tone = { good: "text-emerald-400", mid: "text-amber-300", bad: "text-rose-400" } as const;
  return (
    <span className="flex flex-wrap items-center gap-1.5" data-testid="title-ratings">
      {items.map((x) => (
        <span
          key={x.key}
          data-rating={x.key}
          title={x.key === "tmdb" && m.vote_count > 0 ? t("catalog.detail.votes", { n: m.vote_count.toLocaleString(locale) }) : undefined}
          className="inline-flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-sm font-semibold text-white backdrop-blur"
        >
          <span className="text-[11px] font-bold uppercase tracking-wide text-white/60">{x.label}</span>
          <span className={tone[ratingTone(x.value)]}>{formatRating(x.value)}</span>
        </span>
      ))}
    </span>
  );
}

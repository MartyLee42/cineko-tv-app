import { useEffect, useMemo, useState } from "react";
import { runtime, seasonsCount, useT } from "../core/i18n";
import { details, img, imgFallback, season as loadSeason, titleOf, yearOf, type Details, type MediaType } from "../core/tmdb";
import {
  getPosition,
  isWatched,
  lastWatched,
  preferredVoice,
  setPreferredVoice,
  toggleFavorite,
  useFavorites,
  usePositions,
  useSettings,
  posKey,
  refKey,
  LOCALE,
} from "../core/store";
import { useAsync } from "../shared/hooks";
import { useSource } from "../shared/source";
import { IconFilm, IconHeart, IconMic, IconPlay, IconReplay } from "../shared/icons";
import { navigate, playHref } from "./router";
import { Card, ErrorBox, Rating, Row, Spinner } from "./ui";

function SourceBadge({ status, onRetry }: { status: string; onRetry: () => void }) {
  const t = useT();
  if (status === "loading")
    return (
      <span className="src-badge loading">
        <span className="dot" />
        {t("checking")}
      </span>
    );
  if (status === "error")
    return (
      <button className="src-badge none" onClick={onRetry}>
        {t("sourceError")} · {t("retry")}
      </button>
    );
  return <span className="src-badge none">{t("noSource")}</span>;
}

function refOf(type: MediaType, d: Details) {
  return { type, id: d.id, title: titleOf(d), poster: d.poster_path, backdrop: d.backdrop_path, year: yearOf(d), rating: d.vote_average };
}

export function TitlePage({ type, id, season }: { type: MediaType; id: number; season?: number }) {
  const t = useT();
  const s = useSettings();
  const q = useAsync(() => details(type, id), [type, id, s.lang]);
  const d = q.data;
  const src = useSource(type, d);
  const favs = useFavorites();
  usePositions();
  const fav = favs.some((f) => refKey(f) === `${type}:${id}`);

  useEffect(() => {
    if (d) document.title = `${titleOf(d)} — Cineko`;
    return () => {
      document.title = "Cineko Lite";
    };
  }, [d]);

  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!d) return <Spinner label={t("loading")} />;

  const last = lastWatched({ type, id });
  const movieVoice = type === "movie" ? preferredVoice({ type, id }) : undefined;
  const year = yearOf(d);
  const director = d.credits?.crew.find((c) => c.job === "Director")?.name;
  const rt = type === "movie" ? d.runtime : d.episode_run_time?.[0];
  const countries = (d.production_countries ?? []).map((c) => c.name).slice(0, 2);

  // Series: resume the last episode, else the first available one.
  let playTarget: { season?: number; episode?: number } = {};
  if (type === "tv" && src.seasons.length) {
    if (last?.season != null && last.episode != null) {
      const p = getPosition("tv", id, last.season, last.episode);
      playTarget = { season: last.season, episode: last.episode };
      if (isWatched(p)) {
        const flat = src.seasons.flatMap((x) => x.episodes.map((e) => ({ season: x.season, episode: e.episode })));
        const i = flat.findIndex((x) => x.season === last.season && x.episode === last.episode);
        if (i >= 0 && flat[i + 1]) playTarget = flat[i + 1];
      }
    } else playTarget = { season: src.seasons[0].season, episode: src.seasons[0].episodes[0]?.episode };
  }
  const resumePos = getPosition(type, id, playTarget.season, playTarget.episode);
  const canResume = !!resumePos && resumePos.pos > 15 && !isWatched(resumePos);

  return (
    <div className="title-page">
      <div className="backdrop">
        {d.backdrop_path ? <img src={img(d.backdrop_path, "w1280")} alt="" onError={imgFallback} /> : null}
        <div className="backdrop-shade" />
      </div>
      <div className="title-head">
        <div className="title-poster">
          <div className="poster">
            <div className="poster-ph">
              <IconFilm size={40} />
            </div>
            {d.poster_path ? <img src={img(d.poster_path, "w500")} alt={titleOf(d)} onError={imgFallback} /> : null}
          </div>
        </div>
        <div className="title-info">
          <div className="title-kicker">{type === "tv" ? t("series") : t("movie")}</div>
          <h1 className="title-name">{titleOf(d)}</h1>
          {(d.original_title || d.original_name) && (d.original_title || d.original_name) !== titleOf(d) ? (
            <div className="title-orig">{d.original_title || d.original_name}</div>
          ) : null}
          <div className="title-meta">
            <Rating value={d.vote_average} />
            {year ? <span>{year}</span> : null}
            {rt ? <span>{runtime(rt, s.lang)}</span> : null}
            {type === "tv" && d.number_of_seasons ? (
<span>{seasonsCount(d.number_of_seasons, s.lang)}</span>
            ) : null}
            {countries.length ? <span>{countries.join(", ")}</span> : null}
          </div>
          {d.genres?.length ? (
            <div className="genres">
              {d.genres.map((g) => (
                <span key={g.id} className="genre">
                  {g.name}
                </span>
              ))}
            </div>
          ) : null}
          {d.tagline ? <p className="tagline">«{d.tagline}»</p> : null}
          <div className="title-actions">
            {src.status === "ready" ? (
              <>
                <button className="btn primary big" onClick={() => navigate(playHref(type, id, playTarget.season, playTarget.episode))}>
                  <IconPlay size={20} />
                  {canResume ? t("resume") : t("watch")}
                  {type === "tv" && playTarget.season != null ? (
                    <span className="btn-sub">
                      {t("s")}
                      {playTarget.season} · {t("ep")}
                      {playTarget.episode}
                    </span>
                  ) : null}
                </button>
                {canResume ? (
                  <button className="btn" onClick={() => navigate(playHref(type, id, playTarget.season, playTarget.episode, true))}>
                    <IconReplay size={18} />
                    {t("fromStart")}
                  </button>
                ) : null}
              </>
            ) : (
              <SourceBadge status={src.status} onRetry={src.retry} />
            )}
            <button className={`btn ${fav ? "on" : ""}`} onClick={() => toggleFavorite(refOf(type, d))}>
              <IconHeart size={18} filled={fav} />
              {fav ? t("inFav") : t("addFav")}
            </button>
          </div>
          {d.overview ? <p className="overview">{d.overview}</p> : null}
          {director ? (
            <p className="muted small">
              {t("director")}: {director}
            </p>
          ) : null}
          {type === "movie" && src.status === "ready" && src.voices.length ? (
            <div className="voices">
              <div className="voices-label">
                <IconMic size={16} /> {t("voice")}
              </div>
              <div className="chips">
                {src.voices.map((v) => (
                  <button
                    key={v.key}
                    className={`chip ${movieVoice === v.key ? "on" : ""}`}
                    title={v.kind ? v.kind : undefined}
                    onClick={() => {
                      setPreferredVoice({ type, id }, v.key);
                      navigate(playHref(type, id));
                    }}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {type === "tv" ? <Seasons d={d} src={src} initial={season ?? playTarget.season} /> : null}

      <div className="rows">
        {d.credits?.cast?.length ? (
          <Row title={t("cast")}>
            {d.credits.cast.slice(0, 20).map((c) => (
              <div className="person" key={c.id}>
                <div className="person-img">
                  {c.profile_path ? <img src={img(c.profile_path, "w185")} alt={c.name} loading="lazy" onError={imgFallback} /> : <span>{c.name.slice(0, 1)}</span>}
                </div>
                <div className="person-name">{c.name}</div>
                <div className="person-role">{c.character}</div>
              </div>
            ))}
          </Row>
        ) : null}
        {d.recommendations?.results?.length ? (
          <Row title={t("recommended")}>
            {d.recommendations.results.slice(0, 20).map((it) => (
              <Card key={it.id} item={{ ...it, media_type: it.media_type ?? type }} />
            ))}
          </Row>
        ) : null}
        {d.similar?.results?.length ? (
          <Row title={t("similar")}>
            {d.similar.results.slice(0, 20).map((it) => (
              <Card key={it.id} item={{ ...it, media_type: type }} />
            ))}
          </Row>
        ) : null}
      </div>
    </div>
  );
}

function Seasons({ d, src, initial }: { d: Details; src: ReturnType<typeof useSource>; initial?: number }) {
  const t = useT();
  const s = useSettings();
  const positions = usePositions();
  // Seasons the source has; without a source, TMDB's list (not playable).
  const list = useMemo(() => {
    if (src.seasons.length) return src.seasons.map((x) => x.season);
    return (d.seasons ?? []).filter((x) => x.season_number > 0 && x.episode_count > 0).map((x) => x.season_number);
  }, [src.seasons, d.seasons]);
  const [cur, setCur] = useState<number | undefined>(initial);
  const active = cur != null && list.includes(cur) ? cur : list[0];
  const q = useAsync(() => (active != null ? loadSeason(d.id, active) : Promise.resolve(null)), [d.id, active, s.lang]);
  if (!list.length) return null;
  const avail = src.seasons.find((x) => x.season === active);
  const tmdbEps = q.data?.episodes ?? [];
  const numbers = new Set<number>([...tmdbEps.map((e) => e.episode_number), ...(avail?.episodes.map((e) => e.episode) ?? [])]);
  const eps = [...numbers].sort((a, b) => a - b);

  return (
    <section className="seasons">
      <div className="seasons-head">
        <h2>{t("seasons")}</h2>
        <div className="chips scroll">
          {list.map((n) => (
            <button key={n} className={`chip ${n === active ? "on" : ""}`} onClick={() => setCur(n)}>
              {t("season")} {n}
            </button>
          ))}
        </div>
      </div>
      {q.loading && !q.data ? <Spinner small /> : null}
      <div className="episodes">
        {eps.map((n) => {
          const meta = tmdbEps.find((e) => e.episode_number === n);
          const has = avail?.episodes.find((e) => e.episode === n);
          const p = positions[posKey("tv", d.id, active, n)];
          const pct = p && p.dur ? p.pos / p.dur : 0;
          const watched = isWatched(p);
          return (
            <button
              key={n}
              className={`episode ${has ? "" : "off"} ${watched ? "watched" : ""}`}
              disabled={!has}
              onClick={() => has && navigate(playHref("tv", d.id, active, n))}
            >
              <div className="episode-still">
                {meta?.still_path ? <img src={img(meta.still_path, "w300")} alt="" loading="lazy" onError={imgFallback} /> : <IconFilm size={28} />}
                {has ? (
                  <span className="episode-play">
                    <IconPlay size={22} />
                  </span>
                ) : null}
                {pct > 0 ? (
                  <div className="card-progress">
                    <div style={{ width: `${Math.min(100, pct * 100)}%` }} />
                  </div>
                ) : null}
              </div>
              <div className="episode-body">
                <div className="episode-title">
                  <span className="episode-num">{n}.</span> {meta?.name || `${t("untitledEpisode")} ${n}`}
                </div>
                <div className="episode-meta">
                  {meta?.air_date ? <span>{new Date(meta.air_date).toLocaleDateString(LOCALE[s.lang])}</span> : null}
                  {meta?.runtime ? <span>{runtime(meta.runtime, s.lang)}</span> : null}
                  {watched ? <span className="ok">✓ {t("watched")}</span> : null}
                  {has ? (
                    <span title={has.voices.map((v) => v.label).join(", ")}>
                      <IconMic size={12} /> {has.voices.length}
                    </span>
                  ) : (
                    <span>{t("noSource")}</span>
                  )}
                </div>
                {meta?.overview ? <p className="episode-overview">{meta.overview}</p> : null}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

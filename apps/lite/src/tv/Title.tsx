import { useMemo, useRef, useState } from "react";
import { runtime, seasonsCount, useT } from "../core/i18n";
import { details, img, imgFallback, season as loadSeason, titleOf, typeOf, yearOf, type MediaType } from "../core/tmdb";
import { getPosition, isWatched, lastWatched, posKey, preferredVoice, refKey, setPreferredVoice, toggleFavorite, useFavorites, usePositions, useSettings } from "../core/store";
import { useAsync } from "../shared/hooks";
import { useSource } from "../shared/source";
import { IconFilm, IconHeart, IconMic, IconPlay, IconReplay } from "../shared/icons";
import { F, Loader, PosterCard, Rating, Row, useNav, useScreenFocus } from "./ui";

export function TvTitle({ type, id }: { type: MediaType; id: number }) {
  const t = useT();
  const nav = useNav();
  const s = useSettings();
  const q = useAsync(() => details(type, id), [type, id, s.lang]);
  const d = q.data;
  const src = useSource(type, d);
  const favs = useFavorites();
  const positions = usePositions();
  const scope = useRef<HTMLDivElement>(null);
  const [seasonSel, setSeasonSel] = useState<number>();
  useScreenFocus(!!d && src.status !== "loading", scope);

  const seasonList = useMemo(() => {
    if (src.seasons.length) return src.seasons.map((x) => x.season);
    return (d?.seasons ?? []).filter((x) => x.season_number > 0 && x.episode_count > 0).map((x) => x.season_number);
  }, [src.seasons, d?.seasons]);

  const last = lastWatched({ type, id });
  let target: { season?: number; episode?: number } = {};
  if (type === "tv" && src.seasons.length) {
    const flat = src.seasons.flatMap((x) => x.episodes.map((e) => ({ season: x.season, episode: e.episode })));
    if (last?.season != null && last.episode != null) {
      target = { season: last.season, episode: last.episode };
      if (isWatched(getPosition("tv", id, last.season, last.episode))) {
        const i = flat.findIndex((x) => x.season === last.season && x.episode === last.episode);
        if (i >= 0 && flat[i + 1]) target = flat[i + 1];
      }
    } else target = flat[0] ?? {};
  }
  const activeSeason = seasonSel ?? target.season ?? seasonList[0];
  const seasonQ = useAsync(() => (type === "tv" && activeSeason != null ? loadSeason(id, activeSeason) : Promise.resolve(null)), [id, activeSeason, s.lang]);

  if (q.error) return <div className="terror">{t("error")}</div>;
  if (!d) return <Loader label={t("loading")} />;

  const fav = favs.some((f) => refKey(f) === `${type}:${id}`);
  const resume = getPosition(type, id, target.season, target.episode);
  const canResume = !!resume && resume.pos > 15 && !isWatched(resume);
  const rt = type === "movie" ? d.runtime : d.episode_run_time?.[0];
  const voicePref = preferredVoice({ type, id });
  const avail = src.seasons.find((x) => x.season === activeSeason);
  const tmdbEps = seasonQ.data?.episodes ?? [];
  const epNums = [...new Set<number>([...tmdbEps.map((e) => e.episode_number), ...(avail?.episodes.map((e) => e.episode) ?? [])])].sort((a, b) => a - b);
  const play = (season?: number, episode?: number, fromStart?: boolean) => nav.push({ name: "play", type, id, season, episode, fromStart });

  return (
    <div className="ttitle" ref={scope}>
      <div className="ttitle-bg">
        {d.backdrop_path ? <img src={img(d.backdrop_path, "w1280")} alt="" onError={imgFallback} /> : null}
        <div className="ttitle-shade" />
      </div>
      <div className="ttitle-scroll" data-scroll="y" data-pad="120">
        <div className="ttitle-head">
          <div className="ttitle-poster">
            <div className="pcard-ph">
              <IconFilm size={60} />
            </div>
            {d.poster_path ? <img src={img(d.poster_path, "w500")} alt="" onError={imgFallback} /> : null}
          </div>
          <div className="ttitle-info">
            <div className="kicker">{type === "tv" ? t("series") : t("movie")}</div>
            <h1 className="ttitle-name">{titleOf(d)}</h1>
            <div className="tmeta">
              <Rating value={d.vote_average} />
              {yearOf(d) ? <span>{yearOf(d)}</span> : null}
              {rt ? <span>{runtime(rt, s.lang)}</span> : null}
              {type === "tv" && d.number_of_seasons ? (
                <span>{seasonsCount(d.number_of_seasons, s.lang)}</span>
              ) : null}
              {d.genres?.length ? <span>{d.genres.slice(0, 3).map((g) => g.name).join(", ")}</span> : null}
            </div>
            {d.overview ? <p className="ttitle-overview">{d.overview}</p> : null}
            <div className="tbtns" data-row="" data-group="actions">
              {src.status === "ready" ? (
                <F fk="act-play" className="tbtn primary" autoFocus onPress={() => play(target.season, target.episode)}>
                  <IconPlay size={30} />
                  <span>{canResume ? t("resume") : t("watch")}</span>
                  {type === "tv" && target.season != null ? (
                    <span className="tbtn-sub">
                      {t("s")}
                      {target.season} · {t("ep")}
                      {target.episode}
                    </span>
                  ) : null}
                </F>
              ) : (
                <div className={`tsrc ${src.status}`}>{src.status === "loading" ? t("checking") : src.status === "error" ? t("sourceError") : t("noSource")}</div>
              )}
              {src.status === "ready" && canResume ? (
                <F fk="act-start" className="tbtn" onPress={() => play(target.season, target.episode, true)}>
                  <IconReplay size={28} />
                  <span>{t("fromStart")}</span>
                </F>
              ) : null}
              {src.status === "error" ? (
                <F fk="act-retry" className="tbtn" onPress={src.retry}>
                  <span>{t("retry")}</span>
                </F>
              ) : null}
              <F
                fk="act-fav"
                className={`tbtn ${fav ? "on" : ""}`}
                autoFocus={src.status !== "ready"}
                onPress={() => toggleFavorite({ type, id, title: titleOf(d), poster: d.poster_path, backdrop: d.backdrop_path, year: yearOf(d), rating: d.vote_average })}
              >
                <IconHeart size={28} filled={fav} />
                <span>{fav ? t("inFav") : t("addFav")}</span>
              </F>
            </div>
          </div>
        </div>

        {type === "movie" && src.voices.length ? (
          <section className="tsection" data-row="" data-group="voices">
            <h2 className="trow-title">
              <IconMic size={28} /> {t("voice")}
            </h2>
            <div className="tchips" data-scroll="x">
              <div className="trow-track">
                {src.voices.map((v) => (
                  <F
                    key={v.key}
                    fk={`voice:${v.key}`}
                    className={`tchip ${voicePref === v.key ? "on" : ""}`}
                    onPress={() => {
                      setPreferredVoice({ type, id }, v.key);
                      play();
                    }}
                  >
                    {v.label}
                  </F>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        {type === "tv" && seasonList.length ? (
          <>
            <section className="tsection" data-row="" data-group="seasons">
              <h2 className="trow-title">{t("seasons")}</h2>
              <div className="tchips" data-scroll="x">
                <div className="trow-track">
                  {seasonList.map((n) => (
                    <F key={n} fk={`season:${n}`} isDefault={n === activeSeason} className={`tchip ${n === activeSeason ? "on" : ""}`} onFocus={() => setSeasonSel(n)} onPress={() => setSeasonSel(n)}>
                      {t("season")} {n}
                    </F>
                  ))}
                </div>
              </div>
            </section>
            <Row id="episodes" title={t("episodes")}>
              {epNums.length === 0 ? <Loader /> : null}
              {epNums.map((n) => {
                const meta = tmdbEps.find((e) => e.episode_number === n);
                const has = avail?.episodes.find((e) => e.episode === n);
                const p = positions[posKey("tv", id, activeSeason, n)];
                return (
                  <F
                    key={`${activeSeason}-${n}`}
                    fk={`ep:${activeSeason}:${n}`}
                    isDefault={activeSeason === target.season ? n === target.episode : n === epNums[0]} className={`tep ${has ? "" : "off"} ${isWatched(p) ? "watched" : ""}`} onPress={() => has && play(activeSeason, n)}>
                    <div className="tep-still">
                      {meta?.still_path ? <img src={img(meta.still_path, "w300")} alt="" onError={imgFallback} /> : <IconFilm size={44} />}
                      <span className="tep-num">{n}</span>
                      {p && p.dur ? (
                        <div className="bar">
                          <div style={{ width: `${Math.min(100, (p.pos / p.dur) * 100)}%` }} />
                        </div>
                      ) : null}
                    </div>
                    <div className="tep-name">{meta?.name || `${t("untitledEpisode")} ${n}`}</div>
                    <div className="tep-sub">{has ? `${has.voices.length} · ${has.voices[0]?.label ?? ""}` : t("noSource")}</div>
                  </F>
                );
              })}
            </Row>
          </>
        ) : null}

        {d.recommendations?.results?.length ? (
          <Row id="recs" title={t("recommended")}>
            {d.recommendations.results.slice(0, 20).map((it) => (
              <PosterCard key={it.id} fk={`rec:${it.id}`} item={{ ...it, media_type: it.media_type ?? type }} onPress={() => nav.push({ name: "title", type: typeOf({ ...it, media_type: it.media_type ?? type }), id: it.id })} />
            ))}
          </Row>
        ) : null}
        {d.similar?.results?.length ? (
          <Row id="similar" title={t("similar")}>
            {d.similar.results.slice(0, 20).map((it) => (
              <PosterCard key={it.id} fk={`sim:${it.id}`} item={{ ...it, media_type: type }} onPress={() => nav.push({ name: "title", type, id: it.id })} />
            ))}
          </Row>
        ) : null}
        {d.credits?.cast?.length ? (
          <div className="tcast">
            <span className="muted">{t("cast")}: </span>
            {d.credits.cast
              .slice(0, 10)
              .map((c) => c.name)
              .join(", ")}
          </div>
        ) : null}
        <div className="trows-end" />
      </div>
    </div>
  );
}

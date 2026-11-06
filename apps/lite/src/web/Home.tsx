import { useEffect, useState } from "react";
import { useT } from "../core/i18n";
import { img, imgFallback, titleOf, typeOf, yearOf, type TmdbItem } from "../core/tmdb";
import { continueList, getPosition, removeHistory, useHistory, useSettings, type HistoryEntry } from "../core/store";
import { useAsync } from "../shared/hooks";
import { loadRow, rowById, ROWS } from "../shared/catalog";
import { IconPlay } from "../shared/icons";
import { navigate, playHref, titleHref } from "./router";
import { Mascot, martyMood } from "../shared/marty";
import { Card, ErrorBox, Grid, LazyRow, Rating, Row, SkeletonCards, Spinner } from "./ui";

export function historyItem(h: HistoryEntry): TmdbItem {
  return {
    id: h.id,
    media_type: h.type,
    title: h.type === "movie" ? h.title : undefined,
    name: h.type === "tv" ? h.title : undefined,
    poster_path: h.poster,
    backdrop_path: h.backdrop,
    vote_average: h.rating,
    release_date: h.type === "movie" ? h.year : undefined,
    first_air_date: h.type === "tv" ? h.year : undefined,
  };
}

function Hero({ items }: { items: TmdbItem[] }) {
  const t = useT();
  const list = items.filter((x) => x.backdrop_path && x.overview).slice(0, 6);
  const [i, setI] = useState(0);
  useEffect(() => {
    if (list.length < 2) return;
    const timer = setInterval(() => setI((n) => (n + 1) % list.length), 9000);
    return () => clearInterval(timer);
  }, [list.length]);
  const it = list[i % Math.max(1, list.length)];
  if (!it) return <div className="hero hero-empty" />;
  const type = typeOf(it);
  return (
    <section className="hero">
      {list.map((x, n) => (
        <img
          key={x.id}
          className={`hero-bg ${n === i ? "on" : ""}`}
          src={img(x.backdrop_path, "w1280")}
          alt=""
          onError={imgFallback}
          loading={n === 0 ? "eager" : "lazy"}
        />
      ))}
      <div className="hero-shade" />
      <div className="hero-body">
        <div className="hero-kicker">
          {t("trending")} · {type === "tv" ? t("series") : t("movie")}
        </div>
        <h1 className="hero-title">{titleOf(it)}</h1>
        <div className="hero-meta">
          <Rating value={it.vote_average} />
          <span>{yearOf(it)}</span>
        </div>
        <p className="hero-overview">{it.overview}</p>
        <div className="hero-actions">
          <button className="btn primary" onClick={() => navigate(titleHref(type, it.id))}>
            <IconPlay size={18} />
            {t("details")}
          </button>
        </div>
        <div className="hero-dots">
          {list.map((x, n) => (
            <button key={x.id} className={n === i ? "on" : ""} aria-label={String(n + 1)} onClick={() => setI(n)} />
          ))}
        </div>
      </div>
    </section>
  );
}

function ContinueRow() {
  const t = useT();
  const hist = continueList(useHistory());
  if (!hist.length) return null;
  return (
    <Row title={t("continue")} count={hist.length}>
      {hist.map((h) => {
        const p = getPosition(h.type, h.id, h.season, h.episode);
        return (
          <Card
            key={`${h.type}-${h.id}`}
            item={historyItem(h)}
            progress={p}
            href={playHref(h.type, h.id, h.season, h.episode)}
            sub={h.type === "tv" && h.season != null ? `${t("season")} ${h.season} · ${t("episode")} ${h.episode}` : h.year}
            onRemove={() => removeHistory(h)}
          />
        );
      })}
    </Row>
  );
}

/** Cineko's line for the time of day. */
function Greeting() {
  const t = useT();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 10 * 60_000);
    return () => clearInterval(timer);
  }, []);
  const m = martyMood(now);
  return (
    <div className="greet">
      <Mascot mood={m.mood} size={64} />
      <div className="greet-bubble">
        <span className="greet-name">{t("marty")}</span>
        {t(m.key)}
      </div>
    </div>
  );
}

export function Home() {
  const t = useT();
  const { lang } = useSettings();
  const trending = useAsync(() => loadRow(ROWS[0]), [lang]);
  return (
    <div className="home">
      {trending.data ? <Hero items={trending.data.results} /> : <div className="hero hero-empty" />}
      <div className="rows">
        <Greeting />
        <ContinueRow />
        {trending.error ? <ErrorBox error={trending.error} onRetry={trending.reload} /> : null}
        <Row title={t("trending")} href="#/list/trending">
          {trending.data ? trending.data.results.map((it) => <Card key={`${it.media_type}-${it.id}`} item={it} />) : <SkeletonCards />}
        </Row>
        {ROWS.slice(1).map((r) => (
          <LazyRow key={r.id + lang} def={r} />
        ))}
      </div>
    </div>
  );
}

export function ListPage({ rowId }: { rowId: string }) {
  const t = useT();
  const { lang } = useSettings();
  const def = rowById(rowId);
  const [pages, setPages] = useState<TmdbItem[][]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(1);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPages([]);
    setPage(1);
  }, [rowId, lang]);
  useEffect(() => {
    if (!def) return;
    let alive = true;
    setBusy(true);
    loadRow(def, page).then(
      (r) => {
        if (!alive) return;
        setTotal(r.total_pages);
        setPages((p) => {
          const n = [...p];
          n[page - 1] = r.results;
          return n;
        });
        setBusy(false);
      },
      (e) => alive && (setErr(e), setBusy(false)),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowId, page, lang]);
  if (!def) return <ErrorBox error="not found" />;
  const seen = new Set<string>();
  const items = pages.flat().filter((x) => {
    const k = `${x.media_type}-${x.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return (
    <div className="page">
      <h1 className="page-title">{t(def.label)}</h1>
      {err ? <ErrorBox error={err} /> : null}
      <Grid>
        {items.map((it) => (
          <Card key={`${it.media_type}-${it.id}`} item={it} />
        ))}
        {!items.length && busy ? <SkeletonCards n={12} /> : null}
      </Grid>
      {items.length && page < Math.min(total, 30) ? (
        <div className="more">
          {busy ? (
            <Spinner small />
          ) : (
            <button className="btn" onClick={() => setPage((p) => p + 1)}>
              {t("more")}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useT } from "../core/i18n";
import { img, imgFallback, titleOf, typeOf, yearOf, type TmdbItem } from "../core/tmdb";
import { continueList, getPosition, useHistory, useSettings, type HistoryEntry } from "../core/store";
import { loadRow, rowById, ROWS } from "../shared/catalog";
import { useAsync } from "../shared/hooks";
import { F, Loader, PosterCard, Rating, Row, useNav, useScreenFocus } from "./ui";
import { Mascot, martyMood } from "../shared/marty";

export function historyItem(h: Pick<HistoryEntry, "type" | "id" | "title" | "poster" | "backdrop" | "rating" | "year">): TmdbItem {
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

/** The big artwork + info of the focused title at the top of Home. */
function Hero({ item }: { item?: TmdbItem }) {
  const t = useT();
  const [shown, setShown] = useState(item);
  // Swap the hero a moment after focus settles (fast scrolling stays smooth).
  useEffect(() => {
    const timer = setTimeout(() => setShown(item), 180);
    return () => clearTimeout(timer);
  }, [item]);
  if (!shown) return <div className="thero" />;
  const type = typeOf(shown);
  return (
    <div className="thero">
      {shown.backdrop_path ? <img key={shown.id} className="thero-bg" src={img(shown.backdrop_path, "w1280")} alt="" onError={imgFallback} /> : null}
      <div className="thero-shade" />
      <div className="thero-body">
        <div className="kicker">{type === "tv" ? t("series") : t("movie")}</div>
        <h1 className="thero-title">{titleOf(shown)}</h1>
        <div className="tmeta">
          <Rating value={shown.vote_average} />
          {yearOf(shown) ? <span>{yearOf(shown)}</span> : null}
        </div>
        {shown.overview ? <p className="thero-overview">{shown.overview}</p> : null}
      </div>
    </div>
  );
}

function CatalogRow({ id, label, onFocusItem }: { id: string; label: string; onFocusItem: (it: TmdbItem) => void }) {
  const nav = useNav();
  const def = rowById(id)!;
  const { lang } = useSettings();
  const q = useAsync(() => loadRow(def), [id, lang]);
  const t = useT();
  if (q.error || (q.data && !q.data.results.length)) return null;
  return (
    <Row id={id} title={label}>
      {q.data
        ? q.data.results.slice(0, 20).map((it) => (
            <PosterCard key={`${it.media_type}-${it.id}`} fk={`${id}:${it.media_type}:${it.id}`} item={it} onFocus={() => onFocusItem(it)} onPress={() => nav.push({ name: "title", type: typeOf(it), id: it.id })} />
          ))
        : Array.from({ length: 7 }, (_, i) => <div className="pcard ghost" key={i} />)}
      {q.data ? (
        <F fk={`${id}:all`} className="pcard more" onPress={() => nav.push({ name: "list", row: id })}>
          <div className="pcard-art more-art">
            <span>{t("seeAll")}</span>
          </div>
        </F>
      ) : null}
    </Row>
  );
}

function Greeting() {
  const t = useT();
  const m = martyMood(new Date());
  return (
    <div className="tgreet">
      <div className="tgreet-bubble">
        <span className="tgreet-name">{t("marty")}</span>
        {t(m.key)}
      </div>
      <Mascot mood={m.mood} size={120} />
    </div>
  );
}

export function TvHome() {
  const t = useT();
  const nav = useNav();
  const { lang } = useSettings();
  const hist = continueList(useHistory());
  const trending = useAsync(() => loadRow(ROWS[0]), [lang]);
  const [hero, setHero] = useState<TmdbItem>();
  const scope = useRef<HTMLDivElement>(null);
  useScreenFocus(!!trending.data || !!trending.error, scope);

  return (
    <div className="thome" ref={scope}>
      <Hero item={hero ?? trending.data?.results[0]} />
      <Greeting />
      <div className="trows" data-scroll="y" data-align="top" data-pad="0">
        {hist.length ? (
          <Row id="continue" title={t("continue")}>
            {hist.map((h, i) => {
              const p = getPosition(h.type, h.id, h.season, h.episode);
              return (
                <PosterCard
                  key={`${h.type}-${h.id}`}
                  fk={`continue:${h.type}:${h.id}`}
                  item={historyItem(h)}
                  progress={p && p.dur ? p.pos / p.dur : 0}
                  sub={h.type === "tv" && h.season != null ? `${t("season")} ${h.season} · ${t("episode")} ${h.episode}` : h.year}
                  onFocus={() => setHero({ ...historyItem(h), overview: "" })}
                  autoFocus={i === 0}
                  onPress={() => nav.push({ name: "play", type: h.type, id: h.id, season: h.season, episode: h.episode })}
                />
              );
            })}
          </Row>
        ) : null}
        {trending.error ? <div className="terror">{t("errorNet")}</div> : null}
        {!trending.data && !trending.error ? <Loader /> : null}
        {trending.data ? (
          <Row id="trending" title={t("trending")}>
            {trending.data.results.map((it, i) => (
              <PosterCard
                key={`${it.media_type}-${it.id}`}
                fk={`trending:${it.media_type}:${it.id}`}
                item={it}
                autoFocus={i === 0 && !hist.length}
                onFocus={() => setHero(it)}
                onPress={() => nav.push({ name: "title", type: typeOf(it), id: it.id })}
              />
            ))}
          </Row>
        ) : null}
        {trending.data ? ROWS.slice(1).map((r) => <CatalogRow key={r.id} id={r.id} label={t(r.label)} onFocusItem={setHero} />) : null}
        <div className="trows-end" />
      </div>
    </div>
  );
}

export function TvList({ rowId }: { rowId: string }) {
  const t = useT();
  const nav = useNav();
  const { lang } = useSettings();
  const def = rowById(rowId);
  const [items, setItems] = useState<TmdbItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(1);
  const [busy, setBusy] = useState(true);
  const scope = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!def) return;
    let alive = true;
    setBusy(true);
    loadRow(def, page).then(
      (r) => {
        if (!alive) return;
        setTotal(r.total_pages);
        setItems((prev) => {
          const seen = new Set(prev.map((x) => `${x.media_type}-${x.id}`));
          return [...prev, ...r.results.filter((x) => !seen.has(`${x.media_type}-${x.id}`))];
        });
        setBusy(false);
      },
      () => alive && setBusy(false),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowId, page, lang]);
  useScreenFocus(items.length > 0, scope);
  if (!def) return null;
  return (
    <div className="tpage" ref={scope} data-scroll="y" data-pad="140">
      <h1 className="tpage-title">{t(def.label)}</h1>
      <div className="tgrid">
        {items.map((it, i) => (
          <PosterCard
            key={`${it.media_type}-${it.id}`}
            fk={`list:${it.media_type}:${it.id}`}
            item={it}
            onPress={() => nav.push({ name: "title", type: typeOf(it), id: it.id })}
            onFocus={() => {
              // Near the end: load the next page.
              if (!busy && i >= items.length - 12 && page < Math.min(total, 25)) setPage((p) => p + 1);
            }}
          />
        ))}
      </div>
      {busy ? <Loader /> : null}
    </div>
  );
}

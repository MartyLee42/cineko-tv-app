import { clock, useT } from "../core/i18n";
import { img, imgFallback } from "../core/tmdb";
import { clearHistory, getPosition, removeHistory, toggleFavorite, useFavorites, useHistory, usePositions, useSettings, LOCALE } from "../core/store";
import { IconFilm, IconPlay, IconTrash } from "../shared/icons";
import { historyItem } from "./Home";
import { navigate, playHref, titleHref } from "./router";
import { Card, Empty, Grid } from "./ui";

export function FavoritesPage() {
  const t = useT();
  const favs = useFavorites();
  return (
    <div className="page">
      <h1 className="page-title">
        {t("favorites")} {favs.length ? <span className="row-count">{favs.length}</span> : null}
      </h1>
      {!favs.length ? (
        <Empty mood="love" text={t("emptyFav")} />
      ) : (
        <Grid>
          {favs.map((f) => (
            <Card key={`${f.type}-${f.id}`} item={historyItem({ ...f, position: 0, duration: 0, updatedAt: 0 })} onRemove={() => toggleFavorite(f)} />
          ))}
        </Grid>
      )}
    </div>
  );
}

export function HistoryPage() {
  const t = useT();
  const { lang } = useSettings();
  const hist = useHistory();
  usePositions();
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{t("history")}</h1>
        {hist.length ? (
          <button className="btn ghost" onClick={() => confirm(t("clearHistory") + "?") && clearHistory()}>
            <IconTrash size={16} />
            {t("clearHistory")}
          </button>
        ) : null}
      </div>
      {!hist.length ? (
        <Empty mood="sleepy" animated text={t("emptyHistory")} />
      ) : (
        <div className="history">
          {hist.map((h) => {
            const p = getPosition(h.type, h.id, h.season, h.episode);
            const pct = p && p.dur ? Math.min(100, (p.pos / p.dur) * 100) : 0;
            return (
              <div className="hist" key={`${h.type}-${h.id}`}>
                <a
                  className="hist-art"
                  href={titleHref(h.type, h.id)}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(titleHref(h.type, h.id));
                  }}
                >
                  {h.backdrop || h.poster ? <img src={img(h.backdrop || h.poster, "w300")} alt="" loading="lazy" onError={imgFallback} /> : <IconFilm />}
                  <div className="card-progress">
                    <div style={{ width: `${pct}%` }} />
                  </div>
                </a>
                <div className="hist-body">
                  <a
                    className="hist-title"
                    href={titleHref(h.type, h.id)}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(titleHref(h.type, h.id));
                    }}
                  >
                    {h.title}
                  </a>
                  <div className="hist-meta">
                    {h.type === "tv" && h.season != null ? `${t("season")} ${h.season} · ${t("episode")} ${h.episode} · ` : ""}
                    {p ? `${clock(p.pos)} / ${clock(p.dur)}` : ""}
                    {h.voice ? ` · ${h.voice}` : ""}
                  </div>
                  <div className="hist-date">{new Date(h.updatedAt).toLocaleString(LOCALE[lang], { dateStyle: "medium", timeStyle: "short" })}</div>
                </div>
                <div className="hist-actions">
                  <button className="icon-btn accent" onClick={() => navigate(playHref(h.type, h.id, h.season, h.episode))} aria-label={t("resume")}>
                    <IconPlay />
                  </button>
                  <button className="icon-btn" onClick={() => removeHistory(h)} aria-label={t("remove")}>
                    <IconTrash size={18} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

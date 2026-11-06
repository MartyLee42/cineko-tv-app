import { useRef } from "react";
import { clock, useT } from "../core/i18n";
import { getPosition, removeHistory, useFavorites, useHistory } from "../core/store";
import { historyItem } from "./Home";
import { Empty, F, PosterCard, useNav, useScreenFocus } from "./ui";

export function TvFavorites() {
  const t = useT();
  const nav = useNav();
  const favs = useFavorites();
  const scope = useRef<HTMLDivElement>(null);
  useScreenFocus(true, scope);
  return (
    <div className="tpage" ref={scope} data-scroll="y" data-pad="140">
      <h1 className="tpage-title">{t("favorites")}</h1>
      {!favs.length ? (
        <Empty mood="love" text={t("emptyFav")} />
      ) : (
        <div className="tgrid">
          {favs.map((f) => (
            <PosterCard key={`${f.type}-${f.id}`} fk={`fav:${f.type}:${f.id}`} item={historyItem(f)} onPress={() => nav.push({ name: "title", type: f.type, id: f.id })} />
          ))}
        </div>
      )}
    </div>
  );
}

export function TvHistory() {
  const t = useT();
  const nav = useNav();
  const hist = useHistory();
  const scope = useRef<HTMLDivElement>(null);
  useScreenFocus(true, scope);
  return (
    <div className="tpage" ref={scope} data-scroll="y" data-pad="140">
      <h1 className="tpage-title">{t("history")}</h1>
      {!hist.length ? (
        <Empty mood="sleepy" animated text={t("emptyHistory")} />
      ) : (
        <div className="thist">
          {hist.map((h) => {
            const p = getPosition(h.type, h.id, h.season, h.episode);
            return (
              <div className="thist-row" key={`${h.type}-${h.id}`} data-row="" data-group={`h:${h.type}:${h.id}`}>
                <PosterCard
                  fk={`hist:${h.type}:${h.id}`}
                  item={historyItem(h)}
                  progress={p && p.dur ? p.pos / p.dur : 0}
                  sub={h.type === "tv" && h.season != null ? `${t("season")} ${h.season} · ${t("episode")} ${h.episode}` : p ? `${clock(p.pos)} / ${clock(p.dur)}` : ""}
                  onPress={() => nav.push({ name: "play", type: h.type, id: h.id, season: h.season, episode: h.episode })}
                />
              </div>
            );
          })}
        </div>
      )}
      {hist.length ? (
        <div className="tbtns" style={{ marginTop: 30 }}>
          <F fk="hist-clear-last" className="tbtn" onPress={() => hist[0] && removeHistory(hist[0])}>
            {t("remove")}: {hist[0]?.title}
          </F>
        </div>
      ) : null}
    </div>
  );
}

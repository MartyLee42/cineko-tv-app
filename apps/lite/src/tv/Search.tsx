import { useEffect, useRef, useState } from "react";
import { useT } from "../core/i18n";
import { searchMulti, typeOf, type TmdbItem } from "../core/tmdb";
import { useSettings } from "../core/store";
import { IconSearch } from "../shared/icons";
import { Empty, F, Loader, PosterCard, useNav, useScreenFocus } from "./ui";

const LAYOUTS: Record<string, string[]> = {
  ru: ["абвгдеёжзий", "клмнопрстуф", "хцчшщъыьэюя"],
  kk: ["аәбвгғдеёжз", "ийкқлмнңоөп", "рстуұүфхһцч", "шщъыіьэюя"],
  en: ["abcdefghijk", "lmnopqrstuv", "wxyz"],
};
const DIGITS = "1234567890";

let lastQuery = "";
let lastResults: TmdbItem[] = [];

export function TvSearch() {
  const t = useT();
  const nav = useNav();
  const { lang } = useSettings();
  const [q, setQ] = useState(lastQuery);
  const [layout, setLayout] = useState<string>(lang === "en" ? "en" : lang);
  const [items, setItems] = useState<TmdbItem[]>(lastResults);
  const [busy, setBusy] = useState(false);
  const scope = useRef<HTMLDivElement>(null);
  useScreenFocus(true, scope);

  useEffect(() => {
    lastQuery = q;
    const term = q.trim();
    if (!term) {
      setItems([]);
      lastResults = [];
      return;
    }
    let alive = true;
    setBusy(true);
    const timer = setTimeout(() => {
      searchMulti(term).then(
        (r) => {
          if (!alive) return;
          const list = r.results.filter((x) => x.poster_path).slice(0, 20);
          setItems(list);
          lastResults = list;
          setBusy(false);
        },
        () => alive && setBusy(false),
      );
    }, 450);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, lang]);

  // A physical keyboard (or a remote with letters) types straight in.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key.length === 1 && /[\p{L}\p{N} ]/u.test(e.key) && e.key !== " ") {
        e.preventDefault();
        setQ((x) => x + e.key.toLowerCase());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const order = lang === "en" ? ["en", "ru"] : [lang, "en"];
  const nextLayout = order[(order.indexOf(layout) + 1) % order.length] ?? "en";
  const rows = [...LAYOUTS[layout], DIGITS];

  return (
    <div className="tsearch" ref={scope}>
      <div className="osk" data-group="osk">
        <div className="osk-query">
          <IconSearch size={36} />
          <span className={q ? "" : "muted"}>{q || t("searchPlaceholder")}</span>
          <span className="caret" />
        </div>
        {rows.map((row, ri) => (
          <div className="osk-row" key={ri}>
            {row.split("").map((ch, ci) => (
              <F key={ch} fk={`k:${ch}`} className="osk-key" autoFocus={ri === 0 && ci === 0} onPress={() => setQ((x) => x + ch)}>
                {ch}
              </F>
            ))}
          </div>
        ))}
        <div className="osk-row">
          <F fk="k:space" className="osk-key wide" onPress={() => setQ((x) => (x && !x.endsWith(" ") ? x + " " : x))}>
            {t("space")}
          </F>
          <F fk="k:bs" className="osk-key wide" onPress={() => setQ((x) => x.slice(0, -1))}>
            ⌫
          </F>
          <F fk="k:clear" className="osk-key wide" onPress={() => setQ("")}>
            {t("clear")}
          </F>
          <F fk="k:layout" className="osk-key" onPress={() => setLayout(nextLayout)}>
            {nextLayout.toUpperCase()}
          </F>
        </div>
      </div>
      <div className="tsearch-results" data-scroll="y" data-pad="120">
        {!q.trim() ? (
          <Empty mood="thinking" animated text={t("searchHint")} />
        ) : busy && !items.length ? (
          <Loader />
        ) : !items.length ? (
          <Empty mood="surprised" text={t("nothingFound")} />
        ) : (
          <div className="tgrid small" data-group="results">
            {items.map((it) => (
              <PosterCard key={`${it.media_type}-${it.id}`} fk={`res:${it.media_type}:${it.id}`} item={it} onPress={() => nav.push({ name: "title", type: typeOf(it), id: it.id })} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

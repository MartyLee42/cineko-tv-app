import { useEffect, useRef, useState } from "react";
import { useT } from "../core/i18n";
import { searchMulti, type TmdbItem } from "../core/tmdb";
import { useSettings } from "../core/store";
import { IconSearch } from "../shared/icons";
import { navigate } from "./router";
import { Card, Empty, ErrorBox, Grid, SkeletonCards } from "./ui";

type Filter = "all" | "movie" | "tv";

export function SearchPage({ query }: { query: string }) {
  const t = useT();
  const { lang } = useSettings();
  const [q, setQ] = useState(query);
  const [filter, setFilter] = useState<Filter>("all");
  const [res, setRes] = useState<{ q: string; items: TmdbItem[] } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  // Debounced search; the query is kept in the URL (replace, not push).
  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setRes(null);
      setBusy(false);
      return;
    }
    let alive = true;
    setBusy(true);
    const timer = setTimeout(async () => {
      navigate(`/search?q=${encodeURIComponent(term)}`, true);
      try {
        const [p1, p2] = await Promise.all([searchMulti(term, 1), searchMulti(term, 2).catch(() => null)]);
        if (!alive) return;
        const items = [...p1.results, ...(p2?.results ?? [])];
        items.sort((a, b) => (b.popularity ?? 0) * (b.poster_path ? 1 : 0.2) - (a.popularity ?? 0) * (a.poster_path ? 1 : 0.2));
        setRes({ q: term, items });
        setErr(null);
      } catch (e) {
        if (alive) setErr(e);
      } finally {
        if (alive) setBusy(false);
      }
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, lang]);

  const items = (res?.items ?? []).filter((x) => filter === "all" || x.media_type === filter);
  return (
    <div className="page search-page">
      <div className="search-box">
        <IconSearch size={22} />
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("searchPlaceholder")}
          aria-label={t("search")}
          enterKeyHint="search"
          autoComplete="off"
        />
        {q ? (
          <button className="search-clear" onClick={() => (setQ(""), input.current?.focus())} aria-label={t("clear")}>
            ×
          </button>
        ) : null}
      </div>
      <div className="chips">
        {(["all", "movie", "tv"] as Filter[]).map((f) => (
          <button key={f} className={`chip ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
            {f === "all" ? t("all") : f === "movie" ? t("movies") : t("tvshows")}
          </button>
        ))}
      </div>
      {err ? <ErrorBox error={err} /> : null}
      {!q.trim() ? (
        <Empty mood="thinking" animated text={t("searchHint")} />
      ) : busy && !res ? (
        <Grid>
          <SkeletonCards n={12} />
        </Grid>
      ) : res && !items.length ? (
        <Empty mood="surprised" text={t("nothingFound")} />
      ) : (
        <Grid>
          {items.map((it) => (
            <Card key={`${it.media_type}-${it.id}`} item={it} />
          ))}
        </Grid>
      )}
    </div>
  );
}

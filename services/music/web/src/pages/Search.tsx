import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, img, type Genre, type Me, type SearchResultT, type Track } from "../api";
import { ReleasePicker, TorrentView } from "../dialogs";
import { CloseIcon, PlayIcon, SearchIcon } from "../icons";
import { usePlayer } from "../player";
import { Card, Cover, Empty, ErrorBox, Grid, Loading, Shelf, TrackList } from "../ui";
import { usePlayAlbum, usePlayDzPlaylist } from "./Home";

type Tab = "all" | "tracks" | "albums" | "artists" | "playlists" | "youtube" | "zaycev" | "torrents";

const TABS: [Tab, string][] = [
  ["all", "Все"],
  ["tracks", "Треки"],
  ["albums", "Альбомы"],
  ["artists", "Исполнители"],
  ["playlists", "Плейлисты"],
  ["youtube", "YouTube"],
  ["zaycev", "Zaycev"],
  ["torrents", "Торренты"],
];

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const tab = (params.get("tab") as Tab) ?? "all";
  const [text, setText] = useState(q);
  const input = useRef<HTMLInputElement>(null);
  // Sync from the URL only when it changed from outside (back/forward, links):
  // the URL keeps the trimmed query, so a trailing space being typed must stay.
  useEffect(() => {
    setText((cur) => (cur.trim() === q ? cur : q));
  }, [q]);
  useEffect(() => {
    if (text.trim() === q) return;
    const id = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (text.trim()) next.set("q", text.trim());
      else next.delete("q");
      setParams(next, { replace: true });
    }, 350);
    return () => clearTimeout(id);
  }, [text, q, params, setParams]);
  useEffect(() => {
    if (!q) input.current?.focus();
  }, [q]);
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/me") });
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    next.set("tab", t);
    setParams(next, { replace: true });
  };

  return (
    <div className="page search">
      <div className="search-box">
        <SearchIcon size={20} />
        <input
          ref={input}
          type="search"
          placeholder="Исполнители, треки, альбомы"
          value={text}
          onChange={(e) => setText(e.target.value)}
          enterKeyHint="search"
        />
        {text && (
          <button className="icon-btn" onClick={() => setText("")} title="Очистить">
            <CloseIcon size={16} />
          </button>
        )}
      </div>
      {q ? (
        <>
          <div className="chips">
            {TABS.filter(([t]) => t !== "torrents" || me.data?.features.torrents).map(([t, label]) => (
              <button key={t} className={`chip ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
                {label}
              </button>
            ))}
          </div>
          {tab === "torrents" ? <TorrentSearch q={q} /> : tab === "youtube" ? <YouTubeResults q={q} /> : tab === "zaycev" ? <ZaycevResults q={q} /> : <Results q={q} tab={tab} setTab={setTab} />}
        </>
      ) : (
        <Browse />
      )}
    </div>
  );
}

function Results({ q, tab, setTab }: { q: string; tab: Tab; setTab: (t: Tab) => void }) {
  const r = useQuery({ queryKey: ["search", q], queryFn: () => api.get<SearchResultT>(`/search?q=${encodeURIComponent(q)}`), staleTime: 5 * 60_000 });
  const player = usePlayer();
  const playAlbum = usePlayAlbum();
  const playPl = usePlayDzPlaylist();
  if (r.isLoading) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} retry={() => void r.refetch()} />;
  const d = r.data!;
  const ctx = { type: "search" as const, name: `Поиск: ${q}` };
  if (!d.tracks.length && !d.albums.length && !d.artists.length && !d.playlists.length)
    return <Empty>Ничего не нашли в каталоге по запросу «{q}». Попробуйте вкладки «YouTube», «Zaycev» или «Торренты».</Empty>;

  if (tab === "tracks") return <TrackList tracks={d.tracks} context={ctx} showAlbum />;
  if (tab === "albums")
    return (
      <Grid>
        {d.albums.map((a) => (
          <Card key={a.id} to={`/album/${a.id}`} cover={a.cover} title={a.title} subtitle={a.artist} onPlay={() => void playAlbum(a)} />
        ))}
      </Grid>
    );
  if (tab === "artists")
    return (
      <Grid>
        {d.artists.map((a) => (
          <Card key={a.id} to={`/artist/${a.id}`} cover={a.picture} title={a.name} subtitle="Исполнитель" round />
        ))}
      </Grid>
    );
  if (tab === "playlists")
    return (
      <Grid>
        {d.playlists.map((p) => (
          <Card key={p.id} to={`/playlist/${p.id}`} cover={p.picture} title={p.title} subtitle={p.owner} onPlay={() => void playPl(p)} />
        ))}
      </Grid>
    );

  // "All": top result + tracks + shelves.
  const nq = q.toLowerCase();
  const topArtist = d.artists.find((a) => a.name.toLowerCase() === nq) ?? (d.tracks[0] && d.artists[0]?.id === d.tracks[0].artistId ? d.artists[0] : undefined);
  const topTrack = d.tracks[0];
  return (
    <>
      <div className="top-results">
        <section className="top-result">
          <h2>Лучший результат</h2>
          {topArtist ? (
            <Link to={`/artist/${topArtist.id}`} className="top-card">
              <Cover src={topArtist.picture} round />
              <div className="top-name">{topArtist.name}</div>
              <span className="chip">Исполнитель</span>
            </Link>
          ) : topTrack ? (
            <div className="top-card" onClick={() => player.playList(d.tracks, 0, ctx)}>
              <Cover src={topTrack.cover} />
              <div className="top-name">{topTrack.title}</div>
              <div className="muted">
                <span className="chip">Трек</span> {topTrack.artist}
              </div>
              <button className="card-play show" title="Играть">
                <PlayIcon size={22} />
              </button>
            </div>
          ) : null}
        </section>
        <section className="top-tracks">
          <div className="shelf-head">
            <h2>Треки</h2>
            <button className="shelf-more link" onClick={() => setTab("tracks")}>
              Все
            </button>
          </div>
          <TrackList tracks={d.tracks.slice(0, 5)} context={ctx} playable={d.tracks.slice(0, 5)} />
        </section>
      </div>
      {d.artists.length > 0 && (
        <Shelf title="Исполнители">
          {d.artists.map((a) => (
            <Card key={a.id} to={`/artist/${a.id}`} cover={a.picture} title={a.name} subtitle="Исполнитель" round />
          ))}
        </Shelf>
      )}
      {d.albums.length > 0 && (
        <Shelf title="Альбомы">
          {d.albums.map((a) => (
            <Card key={a.id} to={`/album/${a.id}`} cover={a.cover} title={a.title} subtitle={`${a.artist}`} onPlay={() => void playAlbum(a)} />
          ))}
        </Shelf>
      )}
      {d.playlists.length > 0 && (
        <Shelf title="Плейлисты">
          {d.playlists.map((p) => (
            <Card key={p.id} to={`/playlist/${p.id}`} cover={p.picture} title={p.title} subtitle={p.owner} onPlay={() => void playPl(p)} />
          ))}
        </Shelf>
      )}
    </>
  );
}

function TorrentSearch({ q }: { q: string }) {
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => setHash(null), [q]);
  return (
    <div className="torrent-search">
      <p className="muted small">
        Поиск по трекерам через Prowlarr. Подходит для того, чего нет в каталоге, или чтобы послушать в lossless. Файлы стримятся через
        TorrServer, первый трек стартует за несколько секунд.
      </p>
      {hash ? (
        <>
          <button className="btn ghost small" onClick={() => setHash(null)}>
            ← К результатам
          </button>
          <TorrentView hash={hash} />
        </>
      ) : (
        <ReleasePicker text={q} onOpened={setHash} />
      )}
    </div>
  );
}

function Browse() {
  const g = useQuery({ queryKey: ["genres"], queryFn: () => api.get<Genre[]>("/genres"), staleTime: Infinity });
  return (
    <>
      <h2 className="browse-title">Жанры и настроения</h2>
      {g.isLoading && <Loading />}
      {g.error && <ErrorBox error={g.error} />}
      <div className="genres">
        {g.data?.map((x, i) => (
          <Link key={x.id} to={`/genre/${x.id}`} className="genre" style={{ ["--h" as string]: `${(i * 47) % 360}` }}>
            <span>{x.name}</span>
            {x.picture && <img src={img(x.picture)} alt="" loading="lazy" />}
          </Link>
        ))}
      </div>
    </>
  );
}

function YouTubeResults({ q }: { q: string }) {
  const r = useQuery({ queryKey: ["ytsearch", q], queryFn: () => api.get<Track[]>(`/ytsearch?q=${encodeURIComponent(q)}`), staleTime: 10 * 60_000 });
  if (r.isLoading) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} retry={() => void r.refetch()} />;
  if (!r.data?.length) return <Empty>На YouTube ничего не нашли.</Empty>;
  return (
    <>
      <p className="muted small">Записи с YouTube — каверы, концерты, то, чего нет в каталоге. Их можно лайкать, добавлять в плейлисты и скачивать.</p>
      <TrackList tracks={r.data} context={{ type: "search", name: `YouTube: ${q}` }} />
    </>
  );
}

function ZaycevResults({ q }: { q: string }) {
  const r = useQuery({ queryKey: ["zvsearch", q], queryFn: () => api.get<Track[]>(`/zv/search?q=${encodeURIComponent(q)}`), staleTime: 10 * 60_000 });
  if (r.isLoading) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} retry={() => void r.refetch()} />;
  if (!r.data?.length) return <Empty>На Zaycev ничего не нашли.</Empty>;
  return (
    <>
      <p className="muted small">MP3 с zaycev.net (в основном 320 kbps). Можно лайкать, добавлять в плейлисты и скачивать.</p>
      <TrackList tracks={r.data} context={{ type: "search", name: `Zaycev: ${q}` }} />
    </>
  );
}

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  albumType, api, fmtTotal, plural, tracksWord, type Album, type ArtistPage as ArtistData, type Chart, type DzPlaylist, type Genre, type Me,
  type TorrentInfo, type Track,
} from "../api";
import { albumSource, openPlaylistPicker, openTorrentPicker, setAlbumSource } from "../dialogs";
import { DiscIcon, HeartIcon, MoreIcon, ShuffleIcon, WaveIcon } from "../icons";
import { useLibrary } from "../library";
import { usePlayer } from "../player";
import { BigPlay, Card, DownloadButton, ErrorBox, Hero, Loading, Shelf, TrackList, openMenu, playRadio } from "../ui";
import { ChartSections, usePlayAlbum, usePlayDzPlaylist } from "./Home";

function fans(n?: number) {
  if (!n) return null;
  const v = n >= 1e6 ? `${(n / 1e6).toFixed(1)} млн` : n >= 1e3 ? `${Math.round(n / 1e3)} тыс.` : String(n);
  return `${v} ${plural(n, "слушатель", "слушателя", "слушателей")}`;
}

// ---------------------------------------------------------------- artist

export function ArtistPage() {
  const id = Number(useParams().id);
  const q = useQuery({ queryKey: ["artist", id], queryFn: () => api.get<ArtistData>(`/artist/${id}`), staleTime: 10 * 60_000 });
  const player = usePlayer();
  const lib = useLibrary();
  const playAlbum = usePlayAlbum();
  const playPl = usePlayDzPlaylist();
  const [more, setMore] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} retry={() => void q.refetch()} />;
  const d = q.data!;
  const a = d.artist;
  const ctx = { type: "artist" as const, id: a.id, name: a.name, href: `/artist/${a.id}` };
  const playing = player.playing && player.context?.type === "artist" && player.context.id === a.id;
  const albums = d.albums.filter((x) => x.type === "album" || !x.type);
  const singles = d.albums.filter((x) => x.type === "single" || x.type === "ep");
  const compiles = d.albums.filter((x) => x.type === "compile");
  const followed = lib.isSaved("artist", a.id);
  const albumCard = (x: Album) => (
    <Card key={x.id} to={`/album/${x.id}`} cover={x.cover} title={x.title} subtitle={`${x.year ?? ""} · ${albumType(x.type)}`} onPlay={() => void playAlbum(x)} />
  );
  return (
    <div className="page">
      <Hero cover={a.pictureBig ?? a.picture} round kind="Исполнитель" title={a.name} meta={fans(a.fans)} />
      <div className="actions">
        <BigPlay playing={playing} onClick={() => (playing ? player.toggle() : player.playList(d.top, 0, ctx))} disabled={!d.top.length} />
        <button className="btn ghost" onClick={() => void playRadio(player, a.id, a.name)}>
          <WaveIcon size={18} /> Радио
        </button>
        <button className={`btn ghost ${followed ? "on" : ""}`} onClick={() => void lib.toggleSaved("artist", a)}>
          {followed ? "Вы подписаны" : "Подписаться"}
        </button>
      </div>
      {d.top.length > 0 && (
        <section className="shelf">
          <h2>Популярные треки</h2>
          <TrackList tracks={d.top.slice(0, more ? 20 : 5)} context={ctx} playable={d.top} />
          {d.top.length > 5 && (
            <button className="link more-btn" onClick={() => setMore(!more)}>
              {more ? "Свернуть" : "Ещё"}
            </button>
          )}
        </section>
      )}
      {albums.length > 0 && <Shelf title="Альбомы">{albums.map(albumCard)}</Shelf>}
      {singles.length > 0 && <Shelf title="Синглы и EP">{singles.map(albumCard)}</Shelf>}
      {compiles.length > 0 && <Shelf title="Сборники">{compiles.map(albumCard)}</Shelf>}
      {d.related.length > 0 && (
        <Shelf title="Похожие исполнители">
          {d.related.map((r) => (
            <Card key={r.id} to={`/artist/${r.id}`} cover={r.picture} title={r.name} subtitle="Исполнитель" round />
          ))}
        </Shelf>
      )}
      {d.playlists.length > 0 && (
        <Shelf title="В плейлистах">
          {d.playlists.map((p) => (
            <Card key={p.id} to={`/playlist/${p.id}`} cover={p.picture} title={p.title} subtitle={p.owner} onPlay={() => void playPl(p)} />
          ))}
        </Shelf>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- album

function useAlbumSource(albumId: number) {
  const [hash, setHash] = useState(() => albumSource(albumId));
  useEffect(() => {
    setHash(albumSource(albumId));
    const on = () => setHash(albumSource(albumId));
    window.addEventListener("music:albumsrc", on);
    return () => window.removeEventListener("music:albumsrc", on);
  }, [albumId]);
  return hash;
}

export function AlbumPage() {
  const id = Number(useParams().id);
  const q = useQuery({ queryKey: ["album", id], queryFn: () => api.get<Album>(`/album/${id}`), staleTime: 30 * 60_000 });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/me") });
  const player = usePlayer();
  const lib = useLibrary();
  const qc = useQueryClient();
  const hash = useAlbumSource(id);
  const src = useQuery({
    queryKey: ["albumsrc", id, hash],
    enabled: !!hash,
    queryFn: () => api.get<TorrentInfo>(`/torrents/${hash}?album=${id}`),
    staleTime: 10 * 60_000,
    retry: 1,
  });
  const album = q.data;
  const playable = useMemo<Track[] | undefined>(() => {
    if (!album?.tracks) return undefined;
    const m = src.data?.matched;
    if (!hash || !m) return album.tracks;
    return album.tracks.map((t, i) => m[i] ?? t);
  }, [album, src.data, hash]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} retry={() => void q.refetch()} />;
  const a = album!;
  const tracks = a.tracks ?? [];
  const ctx = { type: "album" as const, id: a.id, name: a.title, href: `/album/${a.id}` };
  const playing = player.playing && player.context?.type === "album" && player.context.id === a.id;
  const saved = lib.isSaved("album", a.id);
  const lossless = !!src.data?.matched?.some(Boolean);
  return (
    <div className="page">
      <Hero
        cover={a.coverBig ?? a.cover}
        kind={albumType(a.type)}
        title={a.title}
        meta={
          <>
            {a.artistId ? <Link to={`/artist/${a.artistId}`}>{a.artist}</Link> : a.artist}
            {a.year && <> · {a.year}</>} · {tracksWord(tracks.length)}
            {a.duration ? <>, {fmtTotal(a.duration)}</> : null}
          </>
        }
      />
      <div className="actions">
        <BigPlay playing={playing} onClick={() => (playing ? player.toggle() : player.playList(playable ?? tracks, 0, ctx))} disabled={!tracks.length} />
        <button className={`icon-btn big like ${saved ? "on" : ""}`} title={saved ? "Убрать из медиатеки" : "В медиатеку"} onClick={() => void lib.toggleSaved("album", a)}>
          <HeartIcon size={30} filled={saved} />
        </button>
        <DownloadButton tracks={playable ?? tracks} />
        {me.data?.features.torrents && (
          <button className={`btn ghost ${lossless ? "on" : ""}`} onClick={() => openTorrentPicker(a)} title="Найти альбом на трекерах и слушать в lossless">
            <DiscIcon size={18} /> {lossless ? "Lossless" : "Lossless из торрента"}
          </button>
        )}
        <button
          className="icon-btn"
          title="Ещё"
          onClick={(e) =>
            openMenu(e, [
              { label: "Перемешать", onClick: () => player.playList([...(playable ?? tracks)].sort(() => Math.random() - 0.5), 0, ctx) },
              { label: "Добавить в очередь", onClick: () => player.addToQueue(playable ?? tracks) },
              { label: "Добавить в плейлист", onClick: () => openPlaylistPicker(playable ?? tracks) },
              ...(a.artistId ? [{ label: "Радио по исполнителю", onClick: () => void playRadio(player, a.artistId!, a.artist) }] : []),
            ])
          }
        >
          <MoreIcon size={22} />
        </button>
      </div>
      {hash && (
        <div className="src-chip">
          <DiscIcon size={14} />
          {src.isLoading
            ? "Подключаем раздачу…"
            : src.error
              ? "Раздача недоступна — играем с YouTube"
              : lossless
                ? `Играет из раздачи: ${src.data?.matched?.filter(Boolean).length} из ${tracks.length} треков`
                : "В раздаче не нашли треки альбома"}
          <button
            className="link small"
            onClick={() => {
              setAlbumSource(a.id, null);
              void qc.invalidateQueries({ queryKey: ["albumsrc", a.id] });
            }}
          >
            Сбросить
          </button>
        </div>
      )}
      <TrackList tracks={tracks} playable={playable} context={ctx} showCover={false} numbered />
      <div className="album-foot muted small">
        {a.date && <div>{new Date(a.date).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}</div>}
        {a.label && <div>© {a.label}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Deezer playlist

export function DzPlaylistPage() {
  const id = Number(useParams().id);
  const q = useQuery({ queryKey: ["playlist", id], queryFn: () => api.get<DzPlaylist>(`/playlist/${id}`), staleTime: 10 * 60_000 });
  const player = usePlayer();
  const lib = useLibrary();
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} retry={() => void q.refetch()} />;
  const p = q.data!;
  const tracks = p.tracks ?? [];
  const ctx = { type: "playlist" as const, id: p.id, name: p.title, href: `/playlist/${p.id}` };
  const playing = player.playing && player.context?.type === "playlist" && player.context.id === p.id;
  const saved = lib.isSaved("playlist", p.id);
  return (
    <div className="page">
      <Hero cover={p.pictureBig ?? p.picture} kind="Плейлист" title={p.title} meta={<>{p.owner && <>{p.owner} · </>}{tracksWord(tracks.length)}</>}>
        {p.description && <p className="hero-desc">{p.description}</p>}
      </Hero>
      <div className="actions">
        <BigPlay playing={playing} onClick={() => (playing ? player.toggle() : player.playList(tracks, 0, ctx))} disabled={!tracks.length} />
        <button className="icon-btn big" title="Перемешать" onClick={() => player.playList([...tracks].sort(() => Math.random() - 0.5), 0, ctx)}>
          <ShuffleIcon size={24} />
        </button>
        <button className={`icon-btn big like ${saved ? "on" : ""}`} title={saved ? "Убрать из медиатеки" : "В медиатеку"} onClick={() => void lib.toggleSaved("playlist", p)}>
          <HeartIcon size={30} filled={saved} />
        </button>
        <DownloadButton tracks={tracks} />
        <button className="btn ghost" onClick={() => openPlaylistPicker(tracks, true)}>
          Сохранить как свой
        </button>
      </div>
      <TrackList tracks={tracks} context={ctx} showAlbum />
    </div>
  );
}

// ---------------------------------------------------------------- genre / chart

export function GenrePage() {
  const id = Number(useParams().id);
  const g = useQuery({ queryKey: ["genres"], queryFn: () => api.get<Genre[]>("/genres"), staleTime: Infinity });
  const q = useQuery({ queryKey: ["genre", id], queryFn: () => api.get<Chart>(`/genre/${id}`), staleTime: 30 * 60_000 });
  const playAlbum = usePlayAlbum();
  const playPl = usePlayDzPlaylist();
  const name = g.data?.find((x) => x.id === id)?.name ?? "Жанр";
  return (
    <div className="page">
      <h1 className="page-title">{name}</h1>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && <ChartSections chart={q.data} playAlbum={playAlbum} playPl={playPl} title="Популярные треки" />}
    </div>
  );
}

export function ChartPage() {
  const q = useQuery({ queryKey: ["genre", 0], queryFn: () => api.get<Chart>(`/genre/0`), staleTime: 30 * 60_000 });
  const player = usePlayer();
  const navigate = useNavigate();
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} retry={() => navigate(0)} />;
  const tracks = q.data!.tracks;
  const ctx = { type: "chart" as const, name: "Чарт", href: "/chart" };
  return (
    <div className="page">
      <h1 className="page-title">Популярное сейчас</h1>
      <div className="actions">
        <BigPlay onClick={() => player.playList(tracks, 0, ctx)} disabled={!tracks.length} />
      </div>
      <TrackList tracks={tracks} context={ctx} showAlbum />
    </div>
  );
}

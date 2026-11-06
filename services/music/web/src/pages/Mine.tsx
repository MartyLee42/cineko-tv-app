import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api, fmtSize, fmtTotal, tracksWord, type MyPlaylist, type PlaylistEntry, type Track } from "../api";
import { openConfirm, openInstallGuide, openNewPlaylist, openPrompt } from "../dialogs";
import { removeDownloads, useOffline } from "../offline";
import { HeartIcon, MoreIcon, PhoneIcon, PlusIcon, ShuffleIcon } from "../icons";
import { useLibrary } from "../library";
import { usePlayer } from "../player";
import { toast } from "../toast";
import { BigPlay, Card, DownloadButton, Empty, ErrorBox, Grid, Hero, Loading, TrackList, openMenu } from "../ui";
import { usePlayAlbum, usePlayDzPlaylist } from "./Home";

type Filter = "all" | "playlists" | "albums" | "artists";

export function LibraryPage() {
  const lib = useLibrary();
  const [f, setF] = useState<Filter>("all");
  const playAlbum = usePlayAlbum();
  const playPl = usePlayDzPlaylist();
  const albums = lib.savedItems.filter((s) => s.kind === "album");
  const artists = lib.savedItems.filter((s) => s.kind === "artist");
  const dzPls = lib.savedItems.filter((s) => s.kind === "playlist");
  if (lib.loading) return <Loading />;
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Моя медиатека</h1>
        <button className="btn ghost" onClick={openNewPlaylist}>
          <PlusIcon size={16} /> Плейлист
        </button>
      </div>
      <div className="chips">
        {(
          [
            ["all", "Всё"],
            ["playlists", "Плейлисты"],
            ["albums", "Альбомы"],
            ["artists", "Исполнители"],
          ] as [Filter, string][]
        ).map(([k, label]) => (
          <button key={k} className={`chip ${f === k ? "on" : ""}`} onClick={() => setF(k)}>
            {label}
          </button>
        ))}
      </div>
      <Grid>
        {(f === "all" || f === "playlists") && (
          <Card
            to="/liked"
            title="Любимые треки"
            subtitle={tracksWord(lib.likesCount)}
            cover={undefined}
            covers={undefined}
          />
        )}
        {(f === "all" || f === "playlists") && <Card to="/downloads" title="Скачанное" subtitle="На этом устройстве" />}
        {(f === "all" || f === "playlists") &&
          lib.playlists.map((p) => <Card key={p.id} to={`/my/${p.id}`} covers={p.covers ?? []} title={p.name} subtitle={`Плейлист · ${tracksWord(p.count)}`} />)}
        {(f === "all" || f === "playlists") &&
          dzPls.map((s) => (
            <Card key={`p${s.id}`} to={`/playlist/${s.id}`} cover={s.data.picture} title={s.data.title} subtitle={`Плейлист · ${s.data.owner ?? ""}`} onPlay={() => void playPl(s.data)} />
          ))}
        {(f === "all" || f === "albums") &&
          albums.map((s) => (
            <Card key={`a${s.id}`} to={`/album/${s.id}`} cover={s.data.cover} title={s.data.title} subtitle={`Альбом · ${s.data.artist}`} onPlay={() => void playAlbum(s.data)} />
          ))}
        {(f === "all" || f === "artists") &&
          artists.map((s) => <Card key={`r${s.id}`} to={`/artist/${s.id}`} cover={s.data.picture} title={s.data.name} subtitle="Исполнитель" round />)}
      </Grid>
      {lib.savedItems.length === 0 && lib.playlists.length === 0 && (
        <Empty>Здесь будут ваши плейлисты, альбомы и исполнители. Нажимайте ♥ на альбомах и «Подписаться» у исполнителей.</Empty>
      )}
    </div>
  );
}

export function LikedPage() {
  const q = useQuery({ queryKey: ["likes"], queryFn: () => api.get<Track[]>("/likes") });
  const lib = useLibrary();
  const player = usePlayer();
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} retry={() => void q.refetch()} />;
  // Unliked tracks disappear right away (library is updated optimistically).
  const tracks = (q.data ?? []).filter((t) => lib.isLiked(t.id));
  const ctx = { type: "liked" as const, name: "Любимые треки", href: "/liked" };
  const playing = player.playing && player.context?.type === "liked";
  const dur = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  return (
    <div className="page">
      <header className="hero liked-hero">
        <div className="hero-art liked-art">
          <HeartIcon size={72} filled />
        </div>
        <div className="hero-text">
          <div className="hero-kind">Плейлист</div>
          <h1>Любимые треки</h1>
          <div className="hero-meta">
            {tracksWord(tracks.length)}
            {dur > 0 && `, ${fmtTotal(dur)}`}
          </div>
        </div>
      </header>
      <div className="actions">
        <BigPlay playing={playing} onClick={() => (playing ? player.toggle() : player.playList(tracks, 0, ctx))} disabled={!tracks.length} />
        <button className="icon-btn big" title="Перемешать" onClick={() => player.playList([...tracks].sort(() => Math.random() - 0.5), 0, ctx)} disabled={!tracks.length}>
          <ShuffleIcon size={24} />
        </button>
        <DownloadButton tracks={tracks} />
      </div>
      {tracks.length ? <TrackList tracks={tracks} context={ctx} showAlbum /> : <Empty>Нажмите ♥ у трека, и он появится здесь.</Empty>}
    </div>
  );
}

export function MyPlaylistPage() {
  const id = Number(useParams().id);
  const q = useQuery({
    queryKey: ["myplaylist", id],
    queryFn: () => api.get<{ playlist: MyPlaylist; entries: PlaylistEntry[] }>(`/playlists/${id}`),
  });
  const player = usePlayer();
  const qc = useQueryClient();
  const navigate = useNavigate();
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} retry={() => void q.refetch()} />;
  const { playlist: p, entries } = q.data!;
  const tracks = entries.map((e) => e.track);
  const ctx = { type: "myplaylist" as const, id: p.id, name: p.name, href: `/my/${p.id}` };
  const playing = player.playing && player.context?.type === "myplaylist" && player.context.id === p.id;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["myplaylist", id] });
    void qc.invalidateQueries({ queryKey: ["library"] });
  };
  const covers: string[] = [];
  for (const t of tracks) if (t.cover && !covers.includes(t.cover) && covers.length < 4) covers.push(t.cover);
  const dur = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const move = async (from: number, to: number) => {
    const ids = entries.map((e) => e.entryId);
    const [x] = ids.splice(from, 1);
    ids.splice(to, 0, x!);
    await api.put(`/playlists/${id}/order`, { entries: ids });
    refresh();
  };
  return (
    <div className="page">
      <Hero cover={covers[0]} covers={covers} kind="Плейлист" title={p.name} meta={<>{tracksWord(tracks.length)}{dur > 0 && `, ${fmtTotal(dur)}`}</>}>
        {p.description && <p className="hero-desc">{p.description}</p>}
      </Hero>
      <div className="actions">
        <BigPlay playing={playing} onClick={() => (playing ? player.toggle() : player.playList(tracks, 0, ctx))} disabled={!tracks.length} />
        <button className="icon-btn big" title="Перемешать" onClick={() => player.playList([...tracks].sort(() => Math.random() - 0.5), 0, ctx)} disabled={!tracks.length}>
          <ShuffleIcon size={24} />
        </button>
        <DownloadButton tracks={tracks} />
        <button
          className="icon-btn"
          title="Ещё"
          onClick={(e) =>
            openMenu(e, [
              {
                label: "Изменить название и описание",
                onClick: () =>
                  openPrompt("Плейлист", p.name, () => undefined, {
                    label: "Описание",
                    initial: p.description,
                    onOk: async (name, desc) => {
                      await api.patch(`/playlists/${id}`, { name, description: desc });
                      refresh();
                    },
                  }),
              },
              { label: "Добавить в очередь", onClick: () => player.addToQueue(tracks), disabled: !tracks.length },
              {
                label: "Удалить плейлист",
                danger: true,
                onClick: () =>
                  openConfirm(`Удалить «${p.name}»?`, "Удалить", async () => {
                    await api.del(`/playlists/${id}`);
                    void qc.invalidateQueries({ queryKey: ["library"] });
                    toast("Плейлист удалён");
                    navigate("/library");
                  }),
              },
            ])
          }
        >
          <MoreIcon size={22} />
        </button>
      </div>
      {tracks.length ? (
        <TrackList
          tracks={tracks}
          context={ctx}
          showAlbum
          menuExtra={(_, i) => [
            ...(i > 0 ? [{ label: "Переместить выше", onClick: () => void move(i, i - 1) }] : []),
            ...(i < entries.length - 1 ? [{ label: "Переместить ниже", onClick: () => void move(i, i + 1) }] : []),
            {
              label: "Удалить из плейлиста",
              danger: true,
              onClick: async () => {
                await api.del(`/playlists/${id}/tracks/${entries[i]!.entryId}`);
                refresh();
              },
            },
          ]}
        />
      ) : (
        <Empty>Плейлист пуст. Добавляйте треки через меню ⋯ → «Добавить в плейлист».</Empty>
      )}
    </div>
  );
}

export function HistoryPage() {
  const q = useQuery({ queryKey: ["history"], queryFn: () => api.get<Track[]>("/history") });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} retry={() => void q.refetch()} />;
  return (
    <div className="page">
      <h1 className="page-title">Недавно слушали</h1>
      {q.data?.length ? (
        <TrackList tracks={q.data} context={{ type: "history", name: "Недавно слушали", href: "/history" }} showAlbum />
      ) : (
        <Empty>Пока пусто.</Empty>
      )}
    </div>
  );
}

export function DownloadsPage() {
  const off = useOffline();
  const player = usePlayer();
  const tracks = off.items.map((i) => i.track);
  const ctx = { type: "other" as const, name: "Скачанное", href: "/downloads" };
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Скачанное</h1>
        <button className="btn ghost" onClick={openInstallGuide}>
          <PhoneIcon size={16} /> Установить приложение
        </button>
      </div>
      <p className="muted small">
        {tracksWord(tracks.length)} · {fmtSize(off.totalBytes)} на этом устройстве
        {off.pending > 0 && ` · скачивается ещё ${off.pending}`}. Играют без интернета. Скачивайте альбомы и плейлисты кнопкой ⬇ или
        через меню трека.
      </p>
      <div className="actions">
        <BigPlay onClick={() => player.playList(tracks, 0, ctx)} disabled={!tracks.length} />
        <button className="icon-btn big" title="Перемешать" onClick={() => player.playList([...tracks].sort(() => Math.random() - 0.5), 0, ctx)} disabled={!tracks.length}>
          <ShuffleIcon size={24} />
        </button>
        {tracks.length > 0 && (
          <button className="btn ghost" onClick={() => openConfirm("Удалить все скачанные треки с устройства?", "Удалить", () => removeDownloads(tracks.map((t) => t.id)))}>
            Удалить все
          </button>
        )}
      </div>
      {tracks.length ? (
        <TrackList tracks={tracks} context={ctx} showAlbum menuExtra={(t) => [{ label: "Удалить с устройства", danger: true, onClick: () => void removeDownloads([t.id]) }]} />
      ) : (
        <Empty>Пока ничего не скачано.</Empty>
      )}
    </div>
  );
}

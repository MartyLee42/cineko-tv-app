import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api, dzId, fmtSize, fmtTime, type Album, type Candidate, type Release, type TorrentInfo, type TorrentTrack, type Track } from "./api";
import { CloseIcon, MagnetIcon, PlayIcon } from "./icons";
import { useLibrary } from "./library";
import { usePlayer } from "./player";
import { canPromptInstall, isIOS, isStandalone, promptInstall } from "./offline";
import { setWireBg, useWireBg } from "./backdrop";
import { DESIGNS, ownDesign, setOwnDesign, tvDesign, type DesignId } from "./themes";
import { useScrollLock } from "./scrolllock";
import { toast } from "./toast";

// ---------------------------------------------------------------- host

type Render = (close: () => void) => ReactNode;
let modalSetter: ((r: Render | null) => void) | null = null;

export function openModal(r: Render) {
  modalSetter?.(r);
}

export function ModalHost() {
  const [render, setRender] = useState<Render | null>(null);
  useEffect(() => {
    modalSetter = (r) => setRender(() => r);
    return () => {
      modalSetter = null;
    };
  }, []);
  useEffect(() => {
    if (!render) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setRender(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [render]);
  if (!render) return null;
  const close = () => setRender(null);
  return <ModalFrame close={close} render={render} />;
}

function ModalFrame({ close, render }: { close: () => void; render: Render }) {
  useScrollLock();
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        {render(close)}
      </div>
    </div>
  );
}

function ModalHead({ title, close }: { title: string; close: () => void }) {
  return (
    <div className="modal-head">
      <h3>{title}</h3>
      <button className="icon-btn" onClick={close} title="Закрыть">
        <CloseIcon size={18} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- playlists

export function openPlaylistPicker(tracks: Track[], create = false) {
  openModal((close) => <PlaylistDialog tracks={tracks} create={create} close={close} />);
}

function PlaylistDialog({ tracks, create, close }: { tracks: Track[]; create: boolean; close: () => void }) {
  const lib = useLibrary();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(create || lib.playlists.length === 0);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await lib.createPlaylist(name.trim(), tracks);
      close();
    } catch (err) {
      toast((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <>
      <ModalHead title={creating ? "Новый плейлист" : "Добавить в плейлист"} close={close} />
      {creating ? (
        <form onSubmit={submit} className="form">
          <input autoFocus className="input" placeholder="Название" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={close}>
              Отмена
            </button>
            <button className="btn primary" disabled={busy || !name.trim()}>
              Создать
            </button>
          </div>
        </form>
      ) : (
        <div className="pick-list">
          <button className="pick-item new" onClick={() => setCreating(true)}>
            + Новый плейлист
          </button>
          {lib.playlists.map((p) => (
            <button
              key={p.id}
              className="pick-item"
              onClick={() => {
                void lib.addToPlaylist(p.id, tracks, p.name);
                close();
              }}
            >
              {p.name} <span className="muted">· {p.count}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function openNewPlaylist() {
  openModal((close) => <PlaylistDialog tracks={[]} create close={close} />);
}

export function openPrompt(title: string, initial: string, onOk: (v: string) => void | Promise<void>, multiline?: { label: string; initial: string; onOk: (name: string, desc: string) => void | Promise<void> }) {
  openModal((close) => <PromptDialog title={title} initial={initial} onOk={onOk} close={close} multiline={multiline} />);
}

function PromptDialog({ title, initial, onOk, close, multiline }: { title: string; initial: string; onOk: (v: string) => void | Promise<void>; close: () => void; multiline?: { label: string; initial: string; onOk: (name: string, desc: string) => void | Promise<void> } }) {
  const [v, setV] = useState(initial);
  const [d, setD] = useState(multiline?.initial ?? "");
  return (
    <>
      <ModalHead title={title} close={close} />
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!v.trim()) return;
          if (multiline) await multiline.onOk(v.trim(), d.trim());
          else await onOk(v.trim());
          close();
        }}
      >
        <input autoFocus className="input" value={v} maxLength={100} onChange={(e) => setV(e.target.value)} />
        {multiline && <textarea className="input" placeholder={multiline.label} value={d} maxLength={500} rows={3} onChange={(e) => setD(e.target.value)} />}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={close}>
            Отмена
          </button>
          <button className="btn primary" disabled={!v.trim()}>
            Сохранить
          </button>
        </div>
      </form>
    </>
  );
}

export function openConfirm(text: string, okLabel: string, onOk: () => void | Promise<void>) {
  openModal((close) => (
    <>
      <ModalHead title={text} close={close} />
      <div className="modal-actions">
        <button className="btn ghost" onClick={close}>
          Отмена
        </button>
        <button
          className="btn danger"
          onClick={async () => {
            await onOk();
            close();
          }}
        >
          {okLabel}
        </button>
      </div>
    </>
  ));
}

// ---------------------------------------------------------------- YouTube match

export function openMatchPicker(t: Track) {
  openModal((close) => <MatchDialog track={t} close={close} />);
}

function MatchDialog({ track, close }: { track: Track; close: () => void }) {
  const id = dzId(track)!;
  const player = usePlayer();
  const q = useQuery({ queryKey: ["candidates", id], queryFn: () => api.get<{ current: string; candidates: Candidate[] }>(`/track/${id}/candidates`) });
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!preview) return;
    const a = new Audio(`/music/api/yt/${preview}?preview=1`);
    const wasPlaying = player.playing;
    if (wasPlaying) player.pause();
    a.play().catch(() => toast("Не удалось воспроизвести"));
    return () => {
      a.pause();
      a.src = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);
  const choose = async (vid: string) => {
    try {
      await api.put(`/track/${id}/match`, { videoId: vid });
      toast("Запись заменена");
      setPreview(null);
      close();
      if (player.current?.id === track.id) player.reloadCurrent();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <>
      <ModalHead title="Выберите запись" close={close} />
      <p className="muted small">
        {track.artist} — {track.title} · {fmtTime(track.duration)}. Звук берётся с YouTube; если попалась не та версия (концерт, кавер), выберите другую.
      </p>
      {q.isLoading && <p className="muted">Ищем…</p>}
      {q.error && <p className="error-text">{(q.error as Error).message}</p>}
      <div className="cand-list">
        {q.data?.candidates.map((c) => (
          <div key={c.videoId} className={`cand ${q.data.current === c.videoId ? "current" : ""}`}>
            <button className="icon-btn" title="Прослушать" onClick={() => setPreview(preview === c.videoId ? null : c.videoId)}>
              {preview === c.videoId ? "■" : <PlayIcon size={16} />}
            </button>
            <div className="cand-text">
              <div className="cand-title">{c.title}</div>
              <div className="muted small">
                {c.author} · {fmtTime(c.duration)}
                {Math.abs(c.duration - track.duration) > 10 && <span className="warn"> · длина отличается</span>}
              </div>
            </div>
            {q.data.current === c.videoId ? (
              <span className="chip">Сейчас</span>
            ) : (
              <button className="btn small" onClick={() => void choose(c.videoId)}>
                Выбрать
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- torrents

const SRC_KEY = (albumId: number) => `mm.albumSrc.${albumId}`;

export function albumSource(albumId: number): string | null {
  try {
    return localStorage.getItem(SRC_KEY(albumId));
  } catch {
    return null;
  }
}

export function setAlbumSource(albumId: number, hash: string | null) {
  try {
    if (hash) localStorage.setItem(SRC_KEY(albumId), hash);
    else localStorage.removeItem(SRC_KEY(albumId));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("music:albumsrc"));
}

export function openTorrentPicker(album: Album) {
  openModal((close) => <TorrentDialog album={album} close={close} />);
}

function TorrentDialog({ album, close }: { album: Album; close: () => void }) {
  const [hash, setHash] = useState<string | null>(null);
  return (
    <>
      <ModalHead title="Лосслесс из торрентов" close={close} />
      {hash ? (
        <TorrentView hash={hash} album={album} onDone={close} onBack={() => setHash(null)} />
      ) : (
        <ReleasePicker artist={album.artist} album={album.title} onOpened={setHash} />
      )}
    </>
  );
}

export function ReleasePicker({ artist, album, text, onOpened }: { artist?: string; album?: string; text?: string; onOpened: (hash: string) => void }) {
  const params = new URLSearchParams();
  if (text) params.set("q", text);
  if (artist) params.set("artist", artist);
  if (album) params.set("album", album);
  const q = useQuery({
    queryKey: ["releases", params.toString()],
    queryFn: () => api.get<Release[]>(`/torrents/search?${params}`),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const [opening, setOpening] = useState<string | null>(null);
  const [fmt, setFmt] = useState<"all" | "lossless" | "mp3">("all");
  const open = async (r: Release) => {
    setOpening(r.id);
    try {
      const res = await api.post<{ hash: string }>("/torrents/open", { id: r.id });
      onOpened(res.hash);
    } catch (e) {
      toast((e as Error).message);
      setOpening(null);
      if ((e as { code?: string }).code === "release_gone") void q.refetch();
    }
  };
  const list = (q.data ?? []).filter((r) =>
    fmt === "all" ? true : fmt === "lossless" ? r.lossless : /mp3|aac|ogg|opus/i.test(r.format) || (!r.lossless && /mp3|320|kbps/i.test(r.title)),
  );
  return (
    <div className="releases">
      {q.isLoading && (
        <div className="searching">
          <span className="spinner" /> Ищем на трекерах… это может занять до 40 секунд
        </div>
      )}
      {q.error && <p className="error-text">{(q.error as Error).message}</p>}
      {q.data && (
        <>
          <div className="rel-filter">
            <div className="chips">
              {(
                [
                  ["all", "Все"],
                  ["lossless", "Lossless"],
                  ["mp3", "MP3"],
                ] as const
              ).map(([k, label]) => (
                <button key={k} className={`chip ${fmt === k ? "on" : ""}`} onClick={() => setFmt(k)}>
                  {label}
                </button>
              ))}
            </div>
            <span className="muted small">{list.length} раздач</span>
          </div>
          {list.length === 0 && <p className="muted">Ничего не нашли.</p>}
          <div className="rel-list">
            {list.map((r) => (
              <button key={r.id} className="rel" disabled={!!opening} onClick={() => void open(r)}>
                <div className="rel-badges">
                  {r.format && <span className={`fmt ${r.lossless ? "lossless" : ""}`}>{r.format}</span>}
                  {r.discography && <span className="fmt disco">Дискография</span>}
                </div>
                <div className="rel-title">{r.title}</div>
                <div className="rel-meta muted small">
                  <span className={r.seeders > 0 ? "seeds" : "noseeds"}>▲ {r.seeders}</span> · {fmtSize(r.size)} · {r.indexer}
                  {r.date && ` · ${r.date}`}
                  {opening === r.id && <span className="spinner inline" />}
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** An opened torrent: album match (when an album is given) and every file. */
export function TorrentView({ hash, album, onDone, onBack }: { hash: string; album?: Album; onDone?: () => void; onBack?: () => void }) {
  const player = usePlayer();
  const qc = useQueryClient();
  const [tries, setTries] = useState(0);
  const q = useQuery({
    queryKey: ["torrent", hash, album?.id ?? 0],
    queryFn: () => api.get<TorrentInfo>(`/torrents/${hash}${album ? `?album=${album.id}` : ""}`),
    refetchInterval: (query) => (query.state.data && !query.state.data.ready && tries < 30 ? 2500 : false),
    retry: 1,
  });
  useEffect(() => {
    if (q.data && !q.data.ready) setTries((t) => t + 1);
  }, [q.data, q.dataUpdatedAt]);
  const [remember, setRemember] = useState(true);
  const info = q.data;
  const groups = useMemo(() => {
    const m = new Map<string, TorrentTrack[]>();
    for (const t of info?.tracks ?? []) {
      const arr = m.get(t.dir) ?? [];
      arr.push(t);
      m.set(t.dir, arr);
    }
    return [...m.entries()];
  }, [info]);
  if (q.isLoading) return <div className="searching"><span className="spinner" /> Подключаемся к раздаче…</div>;
  if (q.error) return <p className="error-text">{(q.error as Error).message}</p>;
  if (!info) return null;
  if (!info.ready)
    return (
      <div className="searching">
        <span className="spinner" /> Получаем список файлов… пиры: {info.peers}
        {tries >= 30 && <p className="error-text">Нет пиров — попробуйте другую раздачу.</p>}
        {onBack && <button className="btn ghost small" onClick={onBack}>Другая раздача</button>}
      </div>
    );
  const matched = info.matched ?? [];
  const found = matched.filter(Boolean).length;
  const playAlbum = () => {
    if (!album?.tracks) return;
    const list = album.tracks.map((t, i) => matched[i] ?? t);
    player.playList(list, 0, { type: "album", id: album.id, name: album.title, href: `/album/${album.id}` });
    if (remember) setAlbumSource(album.id, hash);
    void qc.invalidateQueries({ queryKey: ["albumsrc", album.id] });
    onDone?.();
  };
  return (
    <div className="torrent-view">
      <div className="muted small tv-title">
        <MagnetIcon size={14} /> {info.title} · пиры: {info.peers}
      </div>
      {album && (
        <div className="tv-match">
          {found > 0 ? (
            <>
              <p>
                Нашли <b>{found}</b> из {album.tracks?.length ?? 0} треков альбома
                {found < (album.tracks?.length ?? 0) && " — остальные будут с YouTube"}.
              </p>
              <label className="small">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Всегда играть этот альбом из раздачи
              </label>
              <div className="modal-actions">
                {onBack && <button className="btn ghost" onClick={onBack}>Другая раздача</button>}
                <button className="btn primary" onClick={playAlbum}>
                  <PlayIcon size={16} /> Слушать альбом
                </button>
              </div>
            </>
          ) : (
            <p className="muted">Не нашли треки этого альбома в раздаче — можно выбрать файлы вручную ниже{onBack && <> или <button className="link" onClick={onBack}>другую раздачу</button></>}.</p>
          )}
        </div>
      )}
      <details className="tv-files" open={!album || found === 0}>
        <summary>Все файлы раздачи ({info.tracks.length})</summary>
        {groups.map(([dir, tracks]) => (
          <div key={dir} className="tv-dir">
            <div className="tv-dir-head">
              <span title={dir}>{dir === "." ? info.title : dir}</span>
              <button
                className="btn small"
                onClick={() => {
                  player.playList(tracks, 0, { type: "torrent", name: dir === "." ? info.title : dir.split("/").pop() });
                  onDone?.();
                }}
              >
                <PlayIcon size={14} /> Играть
              </button>
            </div>
            {tracks.map((t, i) => (
              <button
                key={t.id}
                className={`tv-file ${player.current?.id === t.id ? "active" : ""}`}
                onClick={() => player.playList(tracks, i, { type: "torrent", name: dir.split("/").pop() })}
              >
                <span className="muted">{t.number || i + 1}</span>
                <span className="tv-file-title">{t.title}</span>
                <span className="fmt">{t.src?.ext.toUpperCase()}</span>
                {t.duration ? <span className="muted">{fmtTime(t.duration)}</span> : null}
              </button>
            ))}
          </div>
        ))}
      </details>
    </div>
  );
}

// ---------------------------------------------------------------- install

export function openInstallGuide() {
  if (canPromptInstall()) {
    void promptInstall();
    return;
  }
  openModal((close) => (
    <>
      <ModalHead title="Приложение на телефоне" close={close} />
      {isStandalone() ? (
        <p>Уже установлено — вы в приложении.</p>
      ) : isIOS() ? (
        <ol className="steps">
          <li>Откройте эту страницу в <b>Safari</b>.</li>
          <li>Нажмите «Поделиться» (квадрат со стрелкой вверх).</li>
          <li>Выберите «На экран „Домой“» и нажмите «Добавить».</li>
        </ol>
      ) : (
        <ol className="steps">
          <li>Откройте эту страницу в <b>Chrome</b>.</li>
          <li>Меню ⋮ → «Установить приложение» (или «Добавить на главный экран»).</li>
        </ol>
      )}
      <p className="muted small">
        Иконка Cineko Music появится на главном экране, музыка играет в фоне и управляется с экрана блокировки. Скачанные треки играют без
        интернета.
      </p>
    </>
  ));
}

// ---------------------------------------------------------------- design

export function openDesignPicker() {
  openModal((close) => <DesignPicker close={close} />);
}

function DesignPicker({ close }: { close: () => void }) {
  const [sel, setSel] = useState<DesignId | "">(ownDesign());
  const pick = (d: DesignId | "") => {
    setSel(d);
    setOwnDesign(d);
  };
  const tv = DESIGNS.find((d) => d.id === tvDesign())!;
  return (
    <>
      <ModalHead title="Оформление" close={close} />
      <div className="designs">
        <button className={`design-opt ${sel === "" ? "on" : ""}`} onClick={() => pick("")}>
          <Swatch d={tv} />
          <span>Как в Cineko</span>
          <span className="muted small">{tv.name}</span>
        </button>
        {DESIGNS.map((d) => (
          <button key={d.id} className={`design-opt ${sel === d.id ? "on" : ""}`} onClick={() => pick(d.id)}>
            <Swatch d={d} />
            <span>{d.name}</span>
          </button>
        ))}
      </div>
      {(sel || tv.id) === "wireframe" && <WireBgChoice />}
    </>
  );
}

/** «Каркас» only: waves (the TV intro) or the TV's grid floor with mountains. */
function WireBgChoice() {
  const bg = useWireBg();
  return (
    <div className="wire-bg-choice">
      <span className="muted small">Фон «Каркаса»</span>
      {(
        [
          ["waves", "Волны"],
          ["grid", "Сетка"],
        ] as const
      ).map(([id, name]) => (
        <button key={id} className={`chip ${bg === id ? "on" : ""}`} onClick={() => setWireBg(id)}>
          {name}
        </button>
      ))}
    </div>
  );
}

function Swatch({ d }: { d: (typeof DESIGNS)[number] }) {
  return (
    <span className="swatch" style={{ background: d.bg }}>
      <i style={{ background: d.surface }} />
      <b style={{ background: d.accent }} />
      <b style={{ background: d.accent2 }} />
    </span>
  );
}

// ---------------------------------------------------------------- one track from torrents

export function openTrackTorrent(t: Track) {
  openModal((close) => <TrackTorrentDialog track={t} close={close} />);
}

const normT = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

function TrackTorrentDialog({ track, close }: { track: Track; close: () => void }) {
  const [hash, setHash] = useState<string | null>(null);
  const artist = track.artist.split(",")[0]!.trim();
  return (
    <>
      <ModalHead title={`«${track.title}» из торрентов`} close={close} />
      <p className="muted small">
        {artist} — {track.title}
        {track.album ? ` · альбом «${track.album}»` : ""}. Найдите раздачу (MP3 или FLAC) и выберите нужный файл — например, студийную версию вместо концертной.
      </p>
      {hash ? (
        <TrackFilePicker track={track} hash={hash} onBack={() => setHash(null)} close={close} />
      ) : track.album ? (
        <ReleasePicker artist={artist} album={track.album} onOpened={setHash} />
      ) : (
        <ReleasePicker text={`${artist} ${track.title}`} onOpened={setHash} />
      )}
    </>
  );
}

function TrackFilePicker({ track, hash, onBack, close }: { track: Track; hash: string; onBack: () => void; close: () => void }) {
  const player = usePlayer();
  const [always, setAlways] = useState(true);
  const q = useQuery({
    queryKey: ["torrent", hash, 0],
    queryFn: () => api.get<TorrentInfo>(`/torrents/${hash}`),
    refetchInterval: (query) => (query.state.data && !query.state.data.ready ? 2500 : false),
  });
  const want = normT(track.title);
  const files = useMemo(() => {
    const list = q.data?.tracks ?? [];
    const score = (t: TorrentTrack) => {
      const n = normT(t.title);
      let s = n === want ? 100 : n.includes(want) || want.includes(n) ? 60 : 0;
      if (track.album && normT(t.dir).includes(normT(track.album))) s += 15;
      if (/live|концерт|acoustic/i.test(t.dir + " " + t.title)) s -= 20;
      return s;
    };
    return [...list].sort((a, b) => score(b) - score(a));
  }, [q.data, want, track.album]);
  const choose = async (f: TorrentTrack) => {
    if (!f.src) return;
    if (always) {
      try {
        await api.put("/torrentchoice", { trackId: track.id, src: f.src });
        toast("Теперь этот трек играет из раздачи");
      } catch (e) {
        toast((e as Error).message);
        return;
      }
      if (player.current?.id === track.id) player.reloadCurrent();
      else player.playList([track], 0, { type: "other", name: track.title });
    } else {
      player.playList([{ ...track, id: f.id, src: f.src }], 0, { type: "torrent", name: track.title });
    }
    close();
  };
  if (q.isLoading) return <div className="searching"><span className="spinner" /> Подключаемся к раздаче…</div>;
  if (q.error) return <p className="error-text">{(q.error as Error).message}</p>;
  if (!q.data?.ready)
    return (
      <div className="searching">
        <span className="spinner" /> Получаем список файлов… пиры: {q.data?.peers ?? 0}
        <button className="btn ghost small" onClick={onBack}>
          Другая раздача
        </button>
      </div>
    );
  return (
    <div className="torrent-view">
      <label className="small always">
        <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} /> Всегда играть этот трек из выбранного файла
      </label>
      <div className="tv-dir">
        {files.slice(0, 80).map((f, i) => (
          <button key={f.id} className={`tv-file ${i === 0 && normT(f.title) === want ? "best" : ""}`} onClick={() => void choose(f)}>
            <PlayIcon size={14} />
            <span className="tv-file-title">
              {f.title}
              <span className="muted small"> · {f.dir === "." ? "" : f.dir.split("/").pop()}</span>
            </span>
            <span className="fmt">{f.src?.ext.toUpperCase()}</span>
          </button>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onBack}>
          Другая раздача
        </button>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { api, dzId, fmtTime, img, sized, type Track } from "./api";
import { toast } from "./toast";
import { useLibrary } from "./library";
import { usePlayer, type PlayContext } from "./player";
import { HeartIcon, MoreIcon, PauseIcon, PlayIcon, BackIcon, DownloadIcon } from "./icons";
import { openMatchPicker, openPlaylistPicker, openTrackTorrent } from "./dialogs";
import { download, isDownloaded, removeDownloads, useOffline } from "./offline";
import { songsterrLink } from "./songsterr";

// ---------------------------------------------------------------- cover

export function Cover({ src, size = 250, alt = "", round, className = "" }: { src?: string; size?: number; alt?: string; round?: boolean; className?: string }) {
  const [failed, setFailed] = useState(false);
  const url = src && !failed ? img(sized(src, size)) : undefined;
  return (
    <div className={`cover ${round ? "round" : ""} ${className}`}>
      {url ? <img src={url} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} /> : <div className="cover-ph">♪</div>}
    </div>
  );
}

export function Mosaic({ covers, className = "" }: { covers: string[]; className?: string }) {
  if (covers.length < 4) return <Cover src={covers[0]} className={className} />;
  return (
    <div className={`cover mosaic ${className}`}>
      {covers.slice(0, 4).map((c, i) => (
        <img key={i} src={img(sized(c, 120))} alt="" loading="lazy" />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- menus

export interface MenuItem {
  label: string;
  onClick?: () => void;
  /** External link, opened in a new tab by a real <a> (user taps on anchors can hand off to apps). */
  href?: string;
  submenu?: MenuItem[];
  danger?: boolean;
  disabled?: boolean;
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
  title?: string;
}

let menuSetter: ((m: MenuState | null) => void) | null = null;

export function openMenu(e: MouseEvent | { clientX: number; clientY: number }, items: MenuItem[], title?: string) {
  if ("preventDefault" in e) {
    e.preventDefault();
    e.stopPropagation();
  }
  menuSetter?.({ x: e.clientX, y: e.clientY, items, title });
}

export function MenuHost() {
  const [m, setM] = useState<MenuState | null>(null);
  const [stack, setStack] = useState<MenuItem[][]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  useEffect(() => {
    menuSetter = (x) => {
      setM(x);
      setStack([]);
    };
    return () => {
      menuSetter = null;
    };
  }, []);
  useEffect(() => {
    if (!m) return;
    const close = () => setM(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [m]);
  useEffect(() => {
    if (!m || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(m.x, window.innerWidth - r.width - 8));
    const top = m.y + r.height > window.innerHeight - 8 ? Math.max(8, m.y - r.height) : m.y;
    setPos({ left, top });
  }, [m, stack]);
  if (!m) return null;
  const items = stack.length ? stack[stack.length - 1]! : m.items;
  const mobile = window.innerWidth < 760;
  return (
    <div className="menu-backdrop" onClick={() => setM(null)} onContextMenu={(e) => { e.preventDefault(); setM(null); }}>
      <div
        ref={ref}
        className={`menu ${mobile ? "sheet" : ""}`}
        style={mobile ? undefined : { left: pos.left, top: pos.top }}
        onClick={(e) => e.stopPropagation()}
        role="menu"
      >
        {mobile && m.title && !stack.length && <div className="menu-title">{m.title}</div>}
        {stack.length > 0 && (
          <button className="menu-item back" onClick={() => setStack((s) => s.slice(0, -1))}>
            <BackIcon size={16} /> Назад
          </button>
        )}
        {items.map((it, i) =>
          it.href && !it.disabled ? (
            <a key={i} role="menuitem" className="menu-item" href={it.href} target="_blank" rel="noopener" onClick={() => setM(null)}>
              <span>{it.label}</span>
            </a>
          ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            className={`menu-item ${it.danger ? "danger" : ""}`}
            onClick={() => {
              if (it.submenu) {
                setStack((s) => [...s, it.submenu!]);
                return;
              }
              setM(null);
              it.onClick?.();
            }}
          >
            <span>{it.label}</span>
            {it.submenu && <span className="menu-arrow">›</span>}
          </button>
          ),
        )}
      </div>
    </div>
  );
}

/** The ⋯ menu of a track. */
export function useTrackMenu() {
  const player = usePlayer();
  const lib = useLibrary();
  const navigate = useNavigate();
  return (e: MouseEvent, t: Track, extra: MenuItem[] = []) => {
    const items: MenuItem[] = [
      { label: "Играть следующим", onClick: () => player.playNext([t]) },
      { label: "Добавить в очередь", onClick: () => player.addToQueue([t]) },
      { label: lib.isLiked(t.id) ? "Убрать из любимых" : "В любимые", onClick: () => void lib.toggleLike(t) },
      {
        label: "Добавить в плейлист",
        submenu: [
          { label: "+ Новый плейлист", onClick: () => openPlaylistPicker([t], true) },
          ...lib.playlists.map((p) => ({ label: p.name, onClick: () => void lib.addToPlaylist(p.id, [t], p.name) })),
        ],
      },
    ];
    items.push({ label: "Табы и аккорды", submenu: tabLinks(t) });
    if (t.artistId) {
      items.push({ label: "Радио по исполнителю", onClick: () => playRadio(player, t.artistId!, t.artist) });
      items.push({ label: "Перейти к исполнителю", onClick: () => navigate(`/artist/${t.artistId}`) });
    }
    if (t.albumId) items.push({ label: "Перейти к альбому", onClick: () => navigate(`/album/${t.albumId}`) });
    items.push(
      isDownloaded(t.id)
        ? { label: "Удалить с устройства", onClick: () => void removeDownloads([t.id]) }
        : { label: "Скачать на устройство", onClick: () => download([t]) },
    );
    if (dzId(t) !== null) items.push({ label: "Не та запись? Выбрать другую", onClick: () => openMatchPicker(t) });
    if (!t.src) items.push({ label: "Найти в торрентах (MP3 / FLAC)", onClick: () => openTrackTorrent(t) });
    items.push(...extra);
    openMenu(e, items, `${t.title} · ${t.artist}`);
  };
}

export async function playRadio(player: ReturnType<typeof usePlayer>, artistId: number, name: string) {
  try {
    const ts = await api.get<Track[]>(`/artist/${artistId}/radio`);
    player.playList(ts, 0, { type: "radio", id: artistId, name: `Радио: ${name}`, href: `/artist/${artistId}` });
  } catch (e) {
    toast((e as Error).message);
  }
}

// ---------------------------------------------------------------- tracks

export function EqBars() {
  return (
    <span className="eq" aria-label="Играет">
      <i />
      <i />
      <i />
    </span>
  );
}

export function LikeButton({ track, size = 18 }: { track: Track; size?: number }) {
  const lib = useLibrary();
  const liked = lib.isLiked(track.id);
  return (
    <button
      className={`icon-btn like ${liked ? "on" : ""}`}
      title={liked ? "Убрать из любимых" : "В любимые"}
      aria-pressed={liked}
      onClick={(e) => {
        e.stopPropagation();
        void lib.toggleLike(track);
      }}
    >
      <HeartIcon size={size} filled={liked} />
    </button>
  );
}

interface TrackListProps {
  tracks: Track[];
  context: PlayContext;
  showCover?: boolean;
  showAlbum?: boolean;
  numbered?: boolean;
  menuExtra?: (t: Track, i: number) => MenuItem[];
  /** Play this list instead of `tracks` (e.g. torrent-matched versions). */
  playable?: Track[];
}

export function TrackList({ tracks, context, showCover = true, showAlbum = false, numbered = false, menuExtra, playable }: TrackListProps) {
  const player = usePlayer();
  const off = useOffline();
  const lib = useLibrary();
  const menu = useTrackMenu();
  const full = playable ?? tracks;
  // «Только любимые»: in albums and playlists with liked tracks among others.
  const [onlyLiked, setOnlyLiked] = useState(false);
  const likedCount = full.reduce((n, t) => n + (lib.isLiked(t.id) ? 1 : 0), 0);
  const canFilter = ["album", "playlist", "myplaylist", "artist", "chart", "other", "search"].includes(context.type) && likedCount > 0 && likedCount < full.length;
  const idx = tracks.map((_, i) => i).filter((i) => !onlyLiked || !canFilter || lib.isLiked((full[i] ?? tracks[i]!).id));
  const list = idx.map((i) => full[i] ?? tracks[i]!);
  return (
    <div className={`tracklist ${showAlbum ? "with-album" : ""}`}>
      {canFilter && (
        <div className="liked-filter">
          <button className={`chip ${onlyLiked ? "on" : ""}`} onClick={() => setOnlyLiked(!onlyLiked)}>
            ♥ Только любимые · {likedCount}
          </button>
        </div>
      )}
      {idx.map((i, k) => {
        const t = tracks[i]!;
        const pt = full[i] ?? t;
        const active = player.current?.id === pt.id;
        const playing = active && player.playing;
        const liked = lib.isLiked(pt.id);
        return (
          <div
            key={`${t.id}-${i}`}
            className={`track-row ${active ? "active" : ""} ${liked ? "liked" : ""}`}
            onDoubleClick={() => player.playList(list, k, context)}
            onClick={() => window.innerWidth < 760 && player.playList(list, k, context)}
            onContextMenu={(e) => menu(e, pt, menuExtra?.(t, i))}
          >
            <div className="tr-num">
              <span className="n">{playing ? <EqBars /> : numbered ? (t.position ?? i + 1) : i + 1}</span>
              <button
                className="tr-play"
                title={playing ? "Пауза" : "Играть"}
                onClick={(e) => {
                  e.stopPropagation();
                  if (active) player.toggle();
                  else player.playList(list, k, context);
                }}
              >
                {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
              </button>
            </div>
            <div className="tr-main">
              {showCover && <Cover src={t.cover} size={120} className="tr-cover" />}
              <div className="tr-text">
                <div className="tr-title">
                  {t.title}
                  {t.version && <span className="muted"> {t.version}</span>}
                  {t.explicit && <span className="badge-e" title="Ненормативная лексика">E</span>}
                  {pt.src?.lossless && <span className="badge-l">{pt.src.ext.toUpperCase()}</span>}
                  {liked && <span className="liked-mark" title="В любимых">♥</span>}
                </div>
                <div className="tr-artist">
                  {off.isDownloaded(pt.id) && <span className="dl-dot" title="Скачано на устройство">↓</span>}
                  {off.progress.has(pt.id) && <span className="dl-dot busy">{Math.round((off.progress.get(pt.id) ?? 0) * 100)}%</span>}
                  <ArtistLinks track={t} />
                </div>
              </div>
            </div>
            {showAlbum && <div className="tr-album">{t.albumId ? <Link to={`/album/${t.albumId}`} onClick={(e) => e.stopPropagation()}>{t.album}</Link> : t.album}</div>}
            <div className="tr-end">
              <TrackDownload track={pt} />
              <LikeButton track={pt} />
              <span className="tr-dur">{t.duration ? fmtTime(t.duration) : ""}</span>
              <button className="icon-btn" title="Ещё" onClick={(e) => menu(e, pt, menuExtra?.(t, i))}>
                <MoreIcon size={18} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ArtistLinks({ track }: { track: Track }) {
  const people = track.artists && track.artists.length > 1 ? track.artists : track.artistId ? [{ id: track.artistId, name: track.artist }] : null;
  if (!people) return <span>{track.artist}</span>;
  return (
    <>
      {people.map((a, i) => (
        <span key={a.id}>
          {i > 0 && ", "}
          <Link to={`/artist/${a.id}`} onClick={(e) => e.stopPropagation()}>
            {a.name}
          </Link>
        </span>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- cards & shelves

interface CardProps {
  to: string;
  cover?: string;
  covers?: string[];
  title: string;
  subtitle?: ReactNode;
  round?: boolean;
  onPlay?: () => void;
  playing?: boolean;
}

export function Card({ to, cover, covers, title, subtitle, round, onPlay, playing }: CardProps) {
  return (
    <Link to={to} className={`card ${round ? "artist" : ""}`}>
      <div className="card-art">
        {covers && covers.length ? <Mosaic covers={covers} /> : <Cover src={cover} round={round} />}
        {onPlay && (
          <button
            className={`card-play ${playing ? "show" : ""}`}
            title="Играть"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onPlay();
            }}
          >
            {playing ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
          </button>
        )}
      </div>
      <div className="card-title">{title}</div>
      {subtitle && <div className="card-sub">{subtitle}</div>}
    </Link>
  );
}

export function Shelf({ title, to, children }: { title: string; to?: string; children: ReactNode }) {
  return (
    <section className="shelf">
      <div className="shelf-head">
        <h2>{title}</h2>
        {to && (
          <Link to={to} className="shelf-more">
            Все
          </Link>
        )}
      </div>
      <div className="shelf-row">{children}</div>
    </section>
  );
}

export function Grid({ children }: { children: ReactNode }) {
  return <div className="grid">{children}</div>;
}

export function BigPlay({ onClick, playing, disabled }: { onClick: () => void; playing?: boolean; disabled?: boolean }) {
  return (
    <button className="big-play" onClick={onClick} disabled={disabled} title={playing ? "Пауза" : "Играть"}>
      {playing ? <PauseIcon size={26} /> : <PlayIcon size={26} />}
    </button>
  );
}

export function Loading() {
  return (
    <div className="loading">
      <EqBars />
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="error-box">
      <p>{(error as Error)?.message ?? "Ошибка"}</p>
      {retry && (
        <button className="btn" onClick={retry}>
          Повторить
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Hero header for album / artist / playlist pages. */
export function Hero({ cover, covers, round, kind, title, meta, children }: { cover?: string; covers?: string[]; round?: boolean; kind: string; title: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <header className="hero">
      <div className="hero-bg" style={cover ? { backgroundImage: `url(${img(sized(cover, 250))})` } : undefined} />
      <div className="hero-art">{covers && covers.length ? <Mosaic covers={covers} /> : <Cover src={cover} size={500} round={round} />}</div>
      <div className="hero-text">
        <div className="hero-kind">{kind}</div>
        <h1 className={title.length > 28 ? "long" : ""} title={title}>{title}</h1>
        {meta && <div className="hero-meta">{meta}</div>}
        {children}
      </div>
    </header>
  );
}

/** "Download all" button for a list of tracks. */
export function DownloadButton({ tracks }: { tracks: Track[] }) {
  const off = useOffline();
  const all = tracks.length > 0 && tracks.every((t) => off.isDownloaded(t.id));
  const busy = tracks.some((t) => off.progress.has(t.id));
  return (
    <button
      className={`icon-btn big ${all ? "on" : ""}`}
      title={all ? "Скачано — удалить с устройства" : "Скачать на устройство"}
      disabled={!tracks.length}
      onClick={() => (all ? void removeDownloads(tracks.map((t) => t.id)) : download(tracks))}
    >
      {busy ? <span className="spinner" /> : <DownloadIcon size={28} done={all} />}
    </button>
  );
}

/** One-tap download of a single track (tap again to remove it from the device). */
export function TrackDownload({ track, size = 18 }: { track: Track; size?: number }) {
  const off = useOffline();
  const done = off.isDownloaded(track.id);
  const p = off.progress.get(track.id);
  return (
    <button
      className={`icon-btn dl ${done ? "on" : ""}`}
      title={done ? "Скачано — удалить с устройства" : "Скачать на устройство"}
      onClick={(e) => {
        e.stopPropagation();
        if (done) void removeDownloads([track.id]);
        else download([track]);
      }}
    >
      {p !== undefined ? <span className="dl-pct">{Math.round(p * 100)}</span> : <DownloadIcon size={size} done={done} />}
    </button>
  );
}

/** Guitar tabs / chords for a track on the usual sites (opened in a new tab; Songsterr in its app if installed). */
export function tabLinks(t: Track): MenuItem[] {
  const q = `${t.artist.split(",")[0]} ${t.title}`.replace(/\s*[([].*?[)\]]/g, "").trim();
  return [
    {
      label: "Открыть здесь (табы, аккорды)",
      onClick: () =>
        window.dispatchEvent(
          new CustomEvent("music:navigate", { detail: `/tabs?${new URLSearchParams({ artist: t.artist.split(",")[0]!, title: t.title })}` }),
        ),
    },
    { label: "Songsterr (табы)", href: songsterrLink(`https://www.songsterr.com/?pattern=${encodeURIComponent(q)}`, navigator.userAgent) },
    { label: "Ultimate Guitar (аккорды, табы)", href: `https://www.ultimate-guitar.com/search.php?search_type=title&value=${encodeURIComponent(q)}` },
    { label: "AmDm.ru (аккорды)", href: `https://amdm.ru/search/?q=${encodeURIComponent(q)}` },
  ];
}

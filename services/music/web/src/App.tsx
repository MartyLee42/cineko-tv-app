import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router";
import { ApiError, api, login, logout, type Me } from "./api";
import { ModalHost, openDesignPicker, openInstallGuide, openNewPlaylist } from "./dialogs";
import { useOffline } from "./offline";
import { BackIcon, DownloadIcon, ExitIcon, HeartIcon, HomeIcon, LibraryIcon, PlusIcon, SearchIcon, WaveIcon } from "./icons";
import { useLibrary } from "./library";
import { PlayerProvider, usePlayer } from "./player";
import { NowPlaying, PlayerBar, SidePanel, type Panel } from "./playerui";
import { Toasts } from "./toast";
import { PulsarBackdrop, WireBackdrop } from "./backdrop";
import { Cover, EqBars, Loading, MenuHost, openMenu } from "./ui";
import { AlbumPage, ArtistPage, ChartPage, DzPlaylistPage, GenrePage } from "./pages/Catalog";
import { HomePage, useFlow } from "./pages/Home";
import { DownloadsPage, HistoryPage, LibraryPage, LikedPage, MyPlaylistPage } from "./pages/Mine";
import { SearchPage } from "./pages/Search";
import { AiPage } from "./pages/Ai";
import { TabsPage } from "./pages/Tabs";

export function App() {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<Me>("/me"),
    // Offline: give up at once and open the downloads.
    retry: (n, e) => navigator.onLine && !(e instanceof ApiError && e.status === 401) && n < 2,
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    const on = () => void qc.invalidateQueries({ queryKey: ["me"] });
    window.addEventListener("music:unauthorized", on);
    return () => window.removeEventListener("music:unauthorized", on);
  }, [qc]);
  if (me.isLoading) return <Loading />;
  if (me.error instanceof ApiError && me.error.status === 401) return <LoginPage />;
  if (me.error && !(me.error instanceof ApiError)) {
    // No connection: the app (cached by the service worker) plays downloads.
    return (
      <PlayerProvider>
        <Shell me={{ user: { id: "", username: "", displayName: "Офлайн", role: "" }, features: { youtube: false, torrents: false } }} offline />
      </PlayerProvider>
    );
  }
  if (me.error)
    return (
      <div className="center-screen">
        <p>{(me.error as Error).message}</p>
        <button className="btn" onClick={() => void me.refetch()}>
          Повторить
        </button>
      </div>
    );
  return (
    <PlayerProvider>
      <Shell me={me.data!} />
    </PlayerProvider>
  );
}

function Shell({ me, offline }: { me: Me; offline?: boolean }) {
  const [panel, setPanel] = useState<Panel>(null);
  const [expanded, setExpanded] = useState(false);
  const main = useRef<HTMLDivElement>(null);
  const loc = useLocation();
  useEffect(() => {
    main.current?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  }, [loc.pathname]);
  const nav = useNavigate();
  useEffect(() => {
    const on = (e: Event) => nav((e as CustomEvent<string>).detail);
    window.addEventListener("music:navigate", on);
    return () => window.removeEventListener("music:navigate", on);
  }, [nav]);
  useEffect(() => {
    // Phones: the expanded player closes on navigation.
    setExpanded(false);
  }, [loc.pathname, loc.search]);
  return (
    <div className={`shell ${panel ? "with-panel" : ""}`}>
      <WireBackdrop />
      <PulsarBackdrop />
      <Sidebar me={me} />
      <main className="main" ref={main}>
        <TopBar me={me} />
        {offline && <div className="offline-bar">Нет соединения — доступна скачанная музыка</div>}
        <Routes>
          {offline && <Route path="*" element={<DownloadsPage />} />}
          <Route path="/downloads" element={<DownloadsPage />} />
          <Route path="/" element={<HomePage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/ai" element={<AiPage />} />
          <Route path="/tabs" element={<TabsPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/liked" element={<LikedPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/chart" element={<ChartPage />} />
          <Route path="/genre/:id" element={<GenrePage />} />
          <Route path="/artist/:id" element={<ArtistPage />} />
          <Route path="/album/:id" element={<AlbumPage />} />
          <Route path="/playlist/:id" element={<DzPlaylistPage />} />
          <Route path="/my/:id" element={<MyPlaylistPage />} />
          <Route path="*" element={<div className="page empty">Страница не найдена</div>} />
        </Routes>
      </main>
      <SidePanel panel={panel} close={() => setPanel(null)} />
      <PlayerBar panel={panel} setPanel={setPanel} onExpand={() => setExpanded(true)} />
      <MobileNav />
      {expanded && <NowPlaying close={() => setExpanded(false)} />}
      <MenuHost />
      <ModalHost />
      <Toasts />
    </div>
  );
}

function Sidebar({ me }: { me: Me }) {
  const lib = useLibrary();
  const off = useOffline();
  const player = usePlayer();
  const flow = useFlow();
  return (
    <nav className="sidebar">
      <NavLink to="/" className="logo">
        <img src="/music/icon.svg" alt="" />
        <span>Cineko Music</span>
      </NavLink>
      <div className="nav-group">
        <NavLink to="/" end className="nav-item">
          <HomeIcon size={22} /> Главная
        </NavLink>
        <NavLink to="/search" className="nav-item">
          <SearchIcon size={22} /> Поиск
        </NavLink>
        <button className={`nav-item ${flow.active ? "active" : ""}`} onClick={() => void flow.start()}>
          <WaveIcon size={22} /> Моя волна {flow.playing && <EqBars />}
        </button>
      </div>
      <div className="nav-group grow">
        <div className="nav-head">
          <NavLink to="/library" className="nav-item">
            <LibraryIcon size={22} /> Медиатека
          </NavLink>
          <button className="icon-btn" title="Новый плейлист" onClick={openNewPlaylist}>
            <PlusIcon size={18} />
          </button>
        </div>
        <div className="nav-list">
          <NavLink to="/downloads" className="nav-pl">
            <div className="liked-art small dl-art">
              <DownloadIcon size={16} />
            </div>
            <div>
              <div className="nav-pl-name">Скачанное</div>
              <div className="muted small">{off.items.length} на устройстве</div>
            </div>
          </NavLink>
          <NavLink to="/liked" className="nav-pl">
            <div className="liked-art small">
              <HeartIcon size={14} filled />
            </div>
            <div>
              <div className="nav-pl-name">Любимые треки</div>
              <div className="muted small">{lib.likesCount} треков</div>
            </div>
          </NavLink>
          {lib.playlists.map((p) => (
            <NavLink key={p.id} to={`/my/${p.id}`} className="nav-pl">
              <Cover src={p.covers?.[0]} size={120} />
              <div>
                <div className="nav-pl-name">
                  {p.name} {player.playing && player.context?.type === "myplaylist" && player.context.id === p.id && <EqBars />}
                </div>
                <div className="muted small">Плейлист · {p.count}</div>
              </div>
            </NavLink>
          ))}
          {lib.savedItems
            .filter((s) => s.kind !== "artist")
            .slice(0, 30)
            .map((s) => (
              <NavLink key={`${s.kind}${s.id}`} to={s.kind === "album" ? `/album/${s.id}` : `/playlist/${s.id}`} className="nav-pl">
                <Cover src={s.kind === "album" ? s.data.cover : s.data.picture} size={120} />
                <div>
                  <div className="nav-pl-name">{s.data.title}</div>
                  <div className="muted small">{s.kind === "album" ? `Альбом · ${s.data.artist}` : "Плейлист"}</div>
                </div>
              </NavLink>
            ))}
        </div>
      </div>
      <UserBox me={me} />
    </nav>
  );
}

function UserBox({ me }: { me: Me }) {
  const qc = useQueryClient();
  return (
    <div className="user-box">
      <a href="/" className="muted small back-tv" title="Вернуться в Cineko">
        <BackIcon size={14} /> Cineko
      </a>
      <button
        className="user-btn"
        onClick={(e) =>
          openMenu(e, [
            { label: "Вернуться в Cineko", onClick: () => location.assign("/") },
            { label: "Оформление", onClick: openDesignPicker },
            { label: "Установить приложение на телефон", onClick: openInstallGuide },
            {
              label: "Выйти",
              danger: true,
              onClick: async () => {
                await logout(me.user.csrfToken);
                qc.clear();
                location.reload();
              },
            },
          ])
        }
      >
        <span className="avatar">{me.user.displayName.slice(0, 1).toUpperCase()}</span>
        <span className="user-name">{me.user.displayName}</span>
        <ExitIcon size={14} />
      </button>
    </div>
  );
}

function TopBar({ me }: { me: Me }) {
  const navigate = useNavigate();
  const loc = useLocation();
  const root = loc.pathname === "/" || loc.pathname === "/search" || loc.pathname === "/library";
  return (
    <div className="topbar">
      {!root ? (
        <button className="icon-btn round" onClick={() => navigate(-1)} title="Назад">
          <BackIcon size={18} />
        </button>
      ) : (
        <a href="/" className="tv-pill" title="Вернуться в Cineko">
          <BackIcon size={14} /> Cineko
        </a>
      )}
      <button
        className="avatar mobile-only"
        title={me.user.displayName}
        onClick={(e) =>
          openMenu(e, [
            { label: "Вернуться в Cineko", onClick: () => location.assign("/") },
            { label: "Оформление", onClick: openDesignPicker },
            { label: "Установить приложение", onClick: openInstallGuide },
            {
              label: "Выйти",
              danger: true,
              onClick: async () => {
                await logout(me.user.csrfToken);
                location.reload();
              },
            },
          ], me.user.displayName)
        }
      >
        {me.user.displayName.slice(0, 1).toUpperCase()}
      </button>
    </div>
  );
}

function MobileNav() {
  return (
    <nav className="mobile-nav">
      <NavLink to="/" end>
        <HomeIcon size={22} />
        <span>Главная</span>
      </NavLink>
      <NavLink to="/search">
        <SearchIcon size={22} />
        <span>Поиск</span>
      </NavLink>
      <NavLink to="/library">
        <LibraryIcon size={22} />
        <span>Медиатека</span>
      </NavLink>
      <NavLink to="/downloads">
        <DownloadIcon size={22} />
        <span>Скачанное</span>
      </NavLink>
    </nav>
  );
}

function LoginPage() {
  const qc = useQueryClient();
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await login(u, p);
      await qc.invalidateQueries({ queryKey: ["me"] });
    } catch (x) {
      setErr((x as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="center-screen login">
      <img src="/music/icon.svg" alt="" className="login-logo" />
      <h1>Cineko Music</h1>
      <p className="muted">Войдите с аккаунтом Cineko</p>
      <form onSubmit={submit} className="form">
        <input className="input" placeholder="Имя пользователя" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} autoFocus />
        <input className="input" placeholder="Пароль" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} />
        {err && <p className="error-text">{err}</p>}
        <button className="btn primary wide" disabled={busy || !u || !p}>
          Войти
        </button>
      </form>
    </div>
  );
}

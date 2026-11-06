import { useEffect, useState } from "react";
import { useT } from "../core/i18n";
import { useSettings } from "../core/store";
import { applyDesign } from "../core/designs";
import { IconClock, IconGear, IconHeart, IconHome, IconSearch } from "../shared/icons";
import { navigate, useRoute } from "./router";
import { Logo } from "../shared/marty";
import { Home, ListPage } from "./Home";
import { SearchPage } from "./Search";
import { TitlePage } from "./Title";
import { PlayerPage } from "./Player";
import { FavoritesPage, HistoryPage } from "./Library";
import { SettingsPage } from "./Settings";

function NavLink({ to, active, icon, label }: { to: string; active: boolean; icon: React.ReactNode; label: string }) {
  return (
    <a
      href={"#" + to}
      className={`nav-link ${active ? "on" : ""}`}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      {icon}
      <span>{label}</span>
    </a>
  );
}

function Header({ section }: { section: string }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <header className={`top ${scrolled ? "scrolled" : ""}`}>
      <div className="top-inner">
        <a
          href="#/"
          className="top-brand"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          <Logo />
        </a>
        <nav className="top-nav">
          <NavLink to="/" active={section === ""} icon={<IconHome size={18} />} label={t("home")} />
          <NavLink to="/favorites" active={section === "favorites"} icon={<IconHeart size={18} />} label={t("favorites")} />
          <NavLink to="/history" active={section === "history"} icon={<IconClock size={18} />} label={t("history")} />
        </nav>
        <form
          className="top-search"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(`/search?q=${encodeURIComponent(q.trim())}`);
          }}
        >
          <IconSearch size={18} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => section !== "search" && q === "" && navigate("/search")}
            placeholder={t("searchPlaceholder")}
            aria-label={t("search")}
          />
        </form>
        <a
          href="#/search"
          className={`icon-btn top-search-btn ${section === "search" ? "on" : ""}`}
          aria-label={t("search")}
          onClick={(e) => {
            e.preventDefault();
            navigate("/search");
          }}
        >
          <IconSearch />
        </a>
        <a
          href="#/settings"
          className={`icon-btn ${section === "settings" ? "on" : ""}`}
          aria-label={t("settings")}
          onClick={(e) => {
            e.preventDefault();
            navigate("/settings");
          }}
        >
          <IconGear />
        </a>
      </div>
    </header>
  );
}

function TabBar({ section }: { section: string }) {
  const t = useT();
  return (
    <nav className="tabbar">
      <NavLink to="/" active={section === "" || section === "list"} icon={<IconHome />} label={t("home")} />
      <NavLink to="/search" active={section === "search"} icon={<IconSearch />} label={t("search")} />
      <NavLink to="/favorites" active={section === "favorites"} icon={<IconHeart />} label={t("favorites")} />
      <NavLink to="/history" active={section === "history"} icon={<IconClock />} label={t("history")} />
      <NavLink to="/settings" active={section === "settings"} icon={<IconGear />} label={t("settings")} />
    </nav>
  );
}

export function App() {
  const route = useRoute();
  const s = useSettings();
  useEffect(() => applyDesign(s.design, s.light), [s.design, s.light]);
  useEffect(() => {
    document.documentElement.lang = s.lang;
  }, [s.lang]);
  const [section = "", a, b, c, d] = route.parts;

  if (section === "play" && (a === "movie" || a === "tv") && Number(b) > 0) {
    return (
      <PlayerPage
        key={route.hash.split("?")[0]}
        type={a}
        id={Number(b)}
        season={c != null ? Number(c) : undefined}
        episode={d != null ? Number(d) : undefined}
        fromStart={route.query.get("from") === "0"}
      />
    );
  }

  let page: React.ReactNode;
  if ((section === "movie" || section === "tv") && Number(a) > 0) page = <TitlePage key={`${section}/${a}`} type={section} id={Number(a)} season={Number(route.query.get("s")) || undefined} />;
  else if (section === "search") page = <SearchPage query={route.query.get("q") ?? ""} />;
  else if (section === "list" && a) page = <ListPage key={a} rowId={a} />;
  else if (section === "favorites") page = <FavoritesPage />;
  else if (section === "history") page = <HistoryPage />;
  else if (section === "settings") page = <SettingsPage />;
  else page = <Home />;

  return (
    <div className={`app sec-${section || "home"}`}>
      <Header section={section} />
      <main className="main">{page}</main>
      <TabBar section={section} />
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../core/i18n";
import { useSettings } from "../core/store";
import { applyDesign } from "../core/designs";
import { IconClock, IconGear, IconHeart, IconHome, IconSearch } from "../shared/icons";
import { focused, focusedKey, focusInitial, pushKeys, setBackHandler } from "./nav";
import { exitApp } from "./backtrap";
import { Mascot, MARTY_ICON } from "../shared/marty";
import { F, NavCtx, type Nav, type Screen } from "./ui";
import { TvHome, TvList } from "./Home";
import { TvTitle } from "./Title";
import { TvSearch } from "./Search";
import { TvPlayer } from "./Player";
import { TvFavorites, TvHistory } from "./Library";
import { TvSettings } from "./Settings";

interface Entry {
  screen: Screen;
  focus?: string;
  id: number;
}

const SECTIONS: { name: Screen["name"]; icon: (p: { size?: number }) => React.ReactElement; label: "home" | "search" | "favorites" | "history" | "settings" }[] = [
  { name: "search", icon: IconSearch, label: "search" },
  { name: "home", icon: IconHome, label: "home" },
  { name: "favorites", icon: IconHeart, label: "favorites" },
  { name: "history", icon: IconClock, label: "history" },
  { name: "settings", icon: IconGear, label: "settings" },
];

let seq = 1;

function Rail({ active, onPick }: { active: string; onPick: (s: Screen) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // The rail expands while focus is inside it.
    const check = () => setOpen(!!focused()?.closest(".rail"));
    window.addEventListener("keyup", check);
    window.addEventListener("click", check);
    return () => {
      window.removeEventListener("keyup", check);
      window.removeEventListener("click", check);
    };
  }, []);
  return (
    <nav className={`rail ${open ? "open" : ""}`} data-group="rail">
      <div className="rail-brand">
        <img className="rail-icon" src={MARTY_ICON} width={56} height={56} alt="" />
        <div className="rail-brand-text">
          <span className="rail-name">cineko</span>
          <span className="rail-sub">Lite</span>
        </div>
      </div>
      <div className="rail-items">
        {SECTIONS.map((s) => (
          <F key={s.name} fk={`rail-${s.name}`} className={`rail-item ${active === s.name ? "on" : ""}`} isDefault={active === s.name} onPress={() => onPick({ name: s.name } as Screen)} onFocus={() => setOpen(true)}>
            <s.icon size={34} />
            <span className="rail-label">{t(s.label)}</span>
          </F>
        ))}
      </div>
    </nav>
  );
}

export function App() {
  const t = useT();
  const s = useSettings();
  const [stack, setStack] = useState<Entry[]>([{ screen: { name: "home" }, id: 0 }]);
  const [toast, setToast] = useState("");
  // Startup screen: Marty waves while the first rows load (at least ~1 s, at most 5 s).
  const [splash, setSplash] = useState(true);
  useEffect(() => {
    const started = Date.now();
    const done = () => setTimeout(() => setSplash(false), Math.max(0, 1100 - (Date.now() - started)));
    const max = setTimeout(() => setSplash(false), 5000);
    const poll = setInterval(() => {
      if (document.querySelector(".thome .pcard img, .terror")) {
        clearInterval(poll);
        done();
      }
    }, 150);
    return () => {
      clearTimeout(max);
      clearInterval(poll);
    };
  }, []);
  const exitArmed = useRef(0);
  const stackRef = useRef(stack);
  stackRef.current = stack;

  useEffect(() => applyDesign(s.design, s.light), [s.design, s.light]);
  useEffect(() => {
    document.documentElement.lang = s.lang;
  }, [s.lang]);

  const saveFocus = (list: Entry[]): Entry[] => {
    if (!list.length) return list;
    const top = { ...list[list.length - 1], focus: focusedKey() };
    return [...list.slice(0, -1), top];
  };

  const nav: Nav = {
    push: (screen) => setStack((st) => [...saveFocus(st), { screen, id: seq++ }]),
    replace: (screen) => setStack((st) => [...st.slice(0, -1), { screen, id: seq++ }]),
    section: (screen) => setStack((st) => (st.length === 1 && st[0].screen.name === screen.name ? st : [{ screen, id: seq++ }])),
    back: () => undefined,
    remembered: stack[stack.length - 1].focus,
  };

  const back = useCallback(() => {
    const st = stackRef.current;
    if (st.length > 1) {
      setStack(st.slice(0, -1));
      return;
    }
    const top = st[0].screen.name;
    // Focus in the content → go to the rail first; on the rail → Home; on Home → exit (twice).
    if (!focused()?.closest(".rail")) {
      focusInitial(`rail-${top}`, document.querySelector<HTMLElement>(".rail"));
      return;
    }
    if (top !== "home") {
      setStack([{ screen: { name: "home" }, id: seq++ }]);
      return;
    }
    const now = Date.now();
    if (now - exitArmed.current < 2500) {
      exitApp();
      return;
    }
    exitArmed.current = now;
    setToast(t("exitHint"));
    setTimeout(() => setToast(""), 2500);
  }, [t]);
  nav.back = back;

  useEffect(() => setBackHandler(back), [back]);

  // From the leftmost content element, Left opens the rail (nav handles geometry);
  // keep a global safety: if nothing is focused, focus the screen.
  useEffect(
    () =>
      pushKeys(() => {
        if (!focused()) focusInitial(undefined, document.querySelector<HTMLElement>(".screen"));
        return false;
      }),
    [],
  );

  const top = stack[stack.length - 1];
  const sc = top.screen;
  const section = stack[0].screen.name;
  let body: React.ReactNode;
  switch (sc.name) {
    case "play":
      body = <TvPlayer key={top.id} {...sc} />;
      break;
    case "title":
      body = <TvTitle key={top.id} type={sc.type} id={sc.id} />;
      break;
    case "list":
      body = <TvList key={top.id} rowId={sc.row} />;
      break;
    case "search":
      body = <TvSearch key={top.id} />;
      break;
    case "favorites":
      body = <TvFavorites key={top.id} />;
      break;
    case "history":
      body = <TvHistory key={top.id} />;
      break;
    case "settings":
      body = <TvSettings key={top.id} />;
      break;
    default:
      body = <TvHome key={top.id + s.lang} />;
  }

  return (
    <NavCtx.Provider value={nav}>
      <div className={`tv ${sc.name === "play" ? "playing" : ""}`}>
        {sc.name !== "play" ? <Rail active={section} onPick={(x) => nav.section(x)} /> : null}
        <div className="screen">{body}</div>
        {toast ? <div className="ttoast">{toast}</div> : null}
        {splash ? (
          <div className="tsplash">
            <Mascot mood="idle" animated size={340} />
            <div className="tsplash-brand">
              <span className="rail-name">cineko</span>
              <span className="rail-sub">Lite</span>
            </div>
            <div className="tsplash-dots">
              <span />
              <span />
              <span />
            </div>
          </div>
        ) : null}
      </div>
    </NavCtx.Provider>
  );
}

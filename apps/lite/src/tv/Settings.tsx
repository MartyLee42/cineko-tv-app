import { useRef, useState } from "react";
import { useT } from "../core/i18n";
import { DESIGN_NAMES, DESIGN_SWATCH, DESIGNS } from "../core/designs";
import { downloadText, exportData, importData, LANG_NAMES, LANGS, pickTextFile, resetData, setSettings, useSettings, type HostMode } from "../core/store";
import { clearTmdbCache } from "../core/tmdb";
import { Logo } from "../shared/marty";
import { F, useScreenFocus } from "./ui";

const QUALITIES = [0, 2160, 1080, 720, 480];
const HOSTS: HostMode[] = ["auto", "direct", "mirror"];

function Line({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <section className="tset" data-row="" data-group={id}>
      <div className="tset-label">{label}</div>
      <div className="tset-opts">{children}</div>
    </section>
  );
}

export function TvSettings() {
  const t = useT();
  const s = useSettings();
  const scope = useRef<HTMLDivElement>(null);
  const [msg, setMsg] = useState("");
  useScreenFocus(true, scope);
  const hostLabel = (m: HostMode) => (m === "auto" ? t("hostAuto") : m === "direct" ? t("hostDirect") : t("hostMirror"));
  return (
    <div className="tpage tsettings" ref={scope} data-scroll="y" data-pad="160">
      <h1 className="tpage-title">{t("settings")}</h1>
      <Line id="lang" label={t("language")}>
        {LANGS.map((l, i) => (
          <F
            key={l}
            fk={`lang:${l}`}
            autoFocus={i === 0}
            className={`tchip ${s.lang === l ? "on" : ""}`}
            onPress={() => {
              setSettings({ lang: l });
              clearTmdbCache();
            }}
          >
            {LANG_NAMES[l]}
          </F>
        ))}
      </Line>
      <Line id="design" label={t("design")}>
        {DESIGNS.map((d) => {
          const sw = DESIGN_SWATCH[d];
          return (
            <F key={d} fk={`design:${d}`} className={`tdesign ${s.design === d ? "on" : ""}`} onPress={() => setSettings({ design: d })}>
              <span className="tdesign-sw" style={{ background: sw.bg }}>
                <span style={{ background: sw.surface }} />
                <span style={{ background: sw.accent }} />
                <span style={{ background: sw.accent2 }} />
              </span>
              <span>{DESIGN_NAMES[d][s.lang]}</span>
            </F>
          );
        })}
      </Line>
      {s.design === "kinozal" ? (
        <Line id="light" label={t("lightTheme")}>
          <F fk="light:off" className={`tchip ${!s.light ? "on" : ""}`} onPress={() => setSettings({ light: false })}>
            {t("off")}
          </F>
          <F fk="light:on" className={`tchip ${s.light ? "on" : ""}`} onPress={() => setSettings({ light: true })}>
            {t("on")}
          </F>
        </Line>
      ) : null}
      <Line id="quality" label={t("defaultQuality")}>
        {QUALITIES.map((q) => (
          <F key={q} fk={`q:${q}`} className={`tchip ${s.quality === q ? "on" : ""}`} onPress={() => setSettings({ quality: q })}>
            {q ? `${q}p` : t("best")}
          </F>
        ))}
      </Line>
      <Line id="autonext" label={t("autoNext")}>
        <F fk="an:on" className={`tchip ${s.autoNext ? "on" : ""}`} onPress={() => setSettings({ autoNext: true })}>
          {t("on")}
        </F>
        <F fk="an:off" className={`tchip ${!s.autoNext ? "on" : ""}`} onPress={() => setSettings({ autoNext: false })}>
          {t("off")}
        </F>
      </Line>
      <Line id="api" label={t("apiHost")}>
        {HOSTS.map((m) => (
          <F
            key={m}
            fk={`api:${m}`}
            className={`tchip ${s.tmdbApi === m ? "on" : ""}`}
            onPress={() => {
              setSettings({ tmdbApi: m });
              clearTmdbCache();
            }}
          >
            {hostLabel(m)}
          </F>
        ))}
      </Line>
      <Line id="img" label={t("imgHost")}>
        {HOSTS.map((m) => (
          <F key={m} fk={`img:${m}`} className={`tchip ${s.tmdbImg === m ? "on" : ""}`} onPress={() => setSettings({ tmdbImg: m })}>
            {hostLabel(m)}
          </F>
        ))}
      </Line>
      <Line id="data" label={t("data")}>
        <F fk="data:export" className="tchip" onPress={() => downloadText("cineko-lite.json", exportData())}>
          {t("exportData")}
        </F>
        <F
          fk="data:import"
          className="tchip"
          onPress={() =>
            pickTextFile()
              .then((txt) => {
                importData(txt);
                clearTmdbCache();
                setMsg(t("importOk"));
              })
              .catch((e) => e?.message !== "no file" && setMsg(t("importFail")))
          }
        >
          {t("importData")}
        </F>
        <F
          fk="data:reset"
          className="tchip danger"
          onPress={() => {
            if (window.confirm(t("confirmReset"))) {
              resetData();
              location.reload();
            }
          }}
        >
          {t("resetAll")}
        </F>
      </Line>
      {msg ? <p className="tpage-hint">{msg}</p> : null}
      <section className="tabout">
        <Logo size={56} />
        <p>{t("aboutText")}</p>
        <p className="muted">{t("dataHint")}</p>
        <p className="muted">github.com/MartyLee42/cineko-tv-app · TMDB API (not endorsed by TMDB)</p>
      </section>
      <div className="trows-end" />
    </div>
  );
}

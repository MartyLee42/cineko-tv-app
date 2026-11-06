import { useState } from "react";
import { useT } from "../core/i18n";
import { DESIGN_NAMES, DESIGN_SWATCH, DESIGNS } from "../core/designs";
import { downloadText, exportData, importData, LANG_NAMES, LANGS, pickTextFile, resetData, setSettings, useSettings, type HostMode } from "../core/store";
import { API_HOSTS, clearTmdbCache, IMG_HOSTS } from "../core/tmdb";
import { Logo } from "../shared/marty";

const QUALITIES = [0, 2160, 1440, 1080, 720, 480, 360];

function Seg<T extends string | number | boolean>({ value, options, onPick }: { value: T; options: { value: T; label: string }[]; onPick: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={String(o.value)} className={o.value === value ? "on" : ""} onClick={() => onPick(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function HostSetting({ label, mode, custom, hosts, onMode, onCustom }: { label: string; mode: HostMode; custom: string; hosts: { direct: string; mirror: string }; onMode: (m: HostMode) => void; onCustom: (v: string) => void }) {
  const t = useT();
  return (
    <div className="setting">
      <div className="setting-label">{label}</div>
      <Seg
        value={mode}
        onPick={onMode}
        options={[
          { value: "auto", label: t("hostAuto") },
          { value: "direct", label: t("hostDirect") },
          { value: "mirror", label: t("hostMirror") },
          { value: "custom", label: t("hostCustom") },
        ]}
      />
      {mode === "custom" ? (
        <input className="field" value={custom} placeholder={hosts.mirror} onChange={(e) => onCustom(e.target.value)} spellCheck={false} />
      ) : (
        <div className="setting-hint mono">{mode === "mirror" ? hosts.mirror : mode === "direct" ? hosts.direct : `${hosts.direct} → ${hosts.mirror}`}</div>
      )}
    </div>
  );
}

export function SettingsPage() {
  const t = useT();
  const s = useSettings();
  const [key, setKey] = useState(s.tmdbKey);
  const upd = (p: Parameters<typeof setSettings>[0]) => {
    setSettings(p);
    clearTmdbCache();
  };
  return (
    <div className="page settings">
      <h1 className="page-title">{t("settings")}</h1>

      <section className="panel">
        <h2>{t("design")}</h2>
        <div className="designs">
          {DESIGNS.map((d) => {
            const sw = DESIGN_SWATCH[d];
            return (
              <button key={d} className={`design ${s.design === d ? "on" : ""}`} onClick={() => setSettings({ design: d })}>
                <span className="design-swatch" style={{ background: sw.bg, borderColor: sw.surface }}>
                  <span style={{ background: sw.surface }} />
                  <span style={{ background: sw.accent }} />
                  <span style={{ background: sw.accent2 }} />
                </span>
                <span className="design-name">{DESIGN_NAMES[d][s.lang]}</span>
              </button>
            );
          })}
        </div>
        {s.design === "kinozal" ? (
          <label className="toggle">
            <input type="checkbox" checked={s.light} onChange={(e) => setSettings({ light: e.target.checked })} />
            <span className="toggle-ui" />
            {t("lightTheme")}
          </label>
        ) : null}
      </section>

      <section className="panel">
        <h2>{t("language")}</h2>
        <Seg
          value={s.lang}
          onPick={(lang) => upd({ lang })}
          options={LANGS.map((l) => ({ value: l, label: LANG_NAMES[l] }))}
        />
      </section>

      <section className="panel">
        <h2>{t("playback")}</h2>
        <div className="setting">
          <div className="setting-label">{t("defaultQuality")}</div>
          <Seg value={s.quality} onPick={(quality) => setSettings({ quality })} options={QUALITIES.map((q) => ({ value: q, label: q ? `${q}p` : t("best") }))} />
        </div>
        <label className="toggle">
          <input type="checkbox" checked={s.autoNext} onChange={(e) => setSettings({ autoNext: e.target.checked })} />
          <span className="toggle-ui" />
          {t("autoNext")}
        </label>
      </section>

      <section className="panel">
        <h2>{t("tmdb")}</h2>
        <div className="setting">
          <div className="setting-label">{t("tmdbKey")}</div>
          <div className="field-row">
            <input className="field mono" value={key} placeholder={t("tmdbKeyHint")} onChange={(e) => setKey(e.target.value)} spellCheck={false} />
            <button className="btn" disabled={key === s.tmdbKey} onClick={() => upd({ tmdbKey: key.trim() })}>
              OK
            </button>
          </div>
        </div>
        <HostSetting label={t("apiHost")} mode={s.tmdbApi} custom={s.tmdbApiCustom} hosts={API_HOSTS} onMode={(m) => upd({ tmdbApi: m })} onCustom={(v) => upd({ tmdbApiCustom: v })} />
        <HostSetting label={t("imgHost")} mode={s.tmdbImg} custom={s.tmdbImgCustom} hosts={IMG_HOSTS} onMode={(m) => upd({ tmdbImg: m })} onCustom={(v) => upd({ tmdbImgCustom: v })} />
      </section>

      <section className="panel">
        <h2>{t("data")}</h2>
        <p className="muted small">{t("dataHint")}</p>
        <div className="row-btns">
          <button className="btn" onClick={() => downloadText(`cineko-lite-${new Date().toISOString().slice(0, 10)}.json`, exportData())}>
            {t("exportData")}
          </button>
          <button
            className="btn"
            onClick={() =>
              pickTextFile()
                .then((txt) => {
                  importData(txt);
                  clearTmdbCache();
                  alert(t("importOk"));
                })
                .catch((e) => e?.message !== "no file" && alert(t("importFail")))
            }
          >
            {t("importData")}
          </button>
        </div>
      </section>

      <section className="panel about">
        <h2>{t("about")}</h2>
        <Logo size={44} />
        <p>{t("aboutText")}</p>
        <p>
          <a href="https://github.com/MartyLee42/cineko-tv-app" target="_blank" rel="noreferrer">
            {t("fullApp")}
          </a>
        </p>
        <p className="muted small">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
        <button
          className="btn danger"
          onClick={() => {
            if (!confirm(t("confirmReset"))) return;
            resetData();
            location.reload();
          }}
        >
          {t("resetAll")}
        </button>
      </section>
    </div>
  );
}

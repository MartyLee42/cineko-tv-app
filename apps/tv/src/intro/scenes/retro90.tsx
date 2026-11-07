// The startup intro in «retro90» (its own chunk: intro/StartupIntro.tsx loads only the applied design's scene).
import { delay, Mascot } from "../parts";
import "./retro90.css";

// ================================================================ Ретро 90-е

/** Windows 95-style boot: sky with clouds, a bevelled window, a block progress bar, then the taskbar. */
export function Scene() {
  const pix = "'Pixelify Sans', 'JetBrains Mono', monospace";
  const raised = "inset 3px 3px 0 #ffffff, inset -3px -3px 0 #404040, inset 5px 5px 0 #dfdfdf, inset -5px -5px 0 #808080";
  const sunken = "inset 3px 3px 0 #808080, inset -3px -3px 0 #ffffff";
  const cloud = (x: number, y: number, s: number, at: number) => (
    <div className="in-abs r9i-cloud" style={{ left: x, top: y, transform: `scale(${s})`, transformOrigin: "0 0", ...delay(at) }}>
      {[[0, 30, 90, 46], [40, 8, 80, 60], [100, 22, 90, 50], [150, 38, 70, 36]].map(([l, t, w, h], i) => (
        <div key={i} style={{ position: "absolute", left: l, top: t, width: w, height: h, borderRadius: 40, background: "rgba(255,255,255,.92)" }} />
      ))}
    </div>
  );
  return (
    <>
      <div className="in-abs" style={{ width: 1280, height: 720, background: "linear-gradient(180deg, #2f6fd8 0%, #6ea8ef 70%, #a9d0f7 100%)" }} />
      {cloud(80, 90, 1.1, 0)}
      {cloud(900, 60, 0.9, 0.1)}
      {cloud(1040, 400, 1.2, 0.2)}
      {cloud(120, 470, 0.8, 0.15)}
      {/* The desktop takes over at the end. */}
      <div className="in-abs r9i-desk" style={{ width: 1280, height: 720, background: "#006e6e" }} />
      {/* The window. */}
      <div className="in-abs r9i-win" style={{ left: 290, top: 150, width: 700, height: 360, background: "#c0c0c0", boxShadow: raised }}>
        <div style={{ position: "absolute", left: 6, top: 6, right: 6, height: 40, background: "linear-gradient(90deg, #000080 0%, #1084d0 100%)", display: "flex", alignItems: "center", paddingLeft: 12, fontFamily: pix, fontWeight: 600, fontSize: 24, color: "#fff" }}>
          Cineko
          <span style={{ marginLeft: "auto", display: "flex" }}>
            {["_", "□", "×"].map((c) => (
              <span key={c} style={{ width: 30, height: 26, marginRight: 4, background: "#c0c0c0", color: "#000", fontSize: 20, lineHeight: "24px", textAlign: "center", boxShadow: "inset 2px 2px 0 #fff, inset -2px -2px 0 #404040" }}>{c}</span>
            ))}
          </span>
        </div>
        <div style={{ position: "absolute", left: 40, top: 76, display: "flex", alignItems: "center", gap: 26 }}>
          <Mascot color="#000080" ink="#c0c0c0" size={120} cheeks={false} />
          <div style={{ fontFamily: pix, fontWeight: 600, color: "#000" }}>
            <div style={{ fontSize: 92, lineHeight: 1 }}>
              Cineko<span style={{ color: "#000080" }}>TV</span>
              <sup style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 500, fontSize: 36, color: "#808080", marginLeft: 6 }}>95</sup>
            </div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 500, fontSize: 24, marginTop: 10 }}>Загрузка фильмов…</div>
          </div>
        </div>
        {/* Block progress bar (steps). */}
        <div style={{ position: "absolute", left: 40, right: 40, top: 270, height: 40, background: "#fff", boxShadow: sunken, overflow: "hidden" }}>
          <div className="r9i-bar" style={{ position: "absolute", left: 5, top: 6, height: 28, width: 610, backgroundImage: "repeating-linear-gradient(90deg, #000080 0 22px, rgba(0,0,0,0) 22px 26px)" }} />
        </div>
      </div>
      {/* Taskbar with «Пуск» and the clock. */}
      <div className="in-abs r9i-task" style={{ left: 0, top: 672, width: 1280, height: 48, background: "#c0c0c0", boxShadow: "inset 0 3px 0 #ffffff", display: "flex", alignItems: "center", paddingLeft: 8, fontFamily: pix, fontWeight: 600, fontSize: 24, color: "#000" }}>
        <span style={{ padding: "4px 14px", boxShadow: "inset 2px 2px 0 #fff, inset -2px -2px 0 #404040", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ display: "inline-block", width: 18, height: 18, background: "linear-gradient(90deg, #ff3b3b 50%, #3bb54a 50%)", boxShadow: "0 9px 0 0 #1f6fff, 9px 9px 0 0 #ffd23a" }} />
          Пуск
        </span>
        <span style={{ marginLeft: "auto", marginRight: 10, padding: "2px 14px", boxShadow: sunken }}>20:00</span>
      </div>
    </>
  );
}

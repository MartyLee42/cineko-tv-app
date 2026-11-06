// The startup intro: ~3 s, once per app start, in the applied design's
// style (Каркас: the wave-terrain mockup; the others their own motif). It
// lies on top of whatever loads underneath and never takes focus: keys skip
// it and are swallowed while it shows, so spatial navigation keeps its spot.
import { useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import { DESIGN_SWATCH, MAYAKOVSKY, Mascot as MartyMascot, SloganTicker, SovietEmblem, type DesignSetting } from "@martytv/ui";
import { INTRO_FADE_MS, INTRO_MS } from "./logic";
import "./intro.css";

export function StartupIntro({ design, onDone }: { design: DesignSetting; onDone: () => void }) {
  useEffect(() => {
    const done = setTimeout(onDone, INTRO_MS + INTRO_FADE_MS);
    // Capture, before the app's handlers: any key skips (and is used up).
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      onDone();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(done);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onDone]);
  const sw = DESIGN_SWATCH[design];
  const body =
    design === "wireframe" ? <WaveTerrain /> :
    design === "terminal" ? <TerminalBoot /> :
    design === "projector" ? <FilmLeader /> :
    design === "cyberpunk" ? <Glitch /> :
    design === "deco" ? <Sunburst /> :
    design === "retro80" ? <VhsPlay /> :
    design === "retro90" ? <Win95Boot /> :
    design === "popart" ? <ComicPop /> :
    design === "constructivism" ? <PosterDiagonals /> :
    <Curtains />;
  return (
    <div data-testid="startup-intro" data-design={design} className="in-root" style={{ background: sw.bg }}>
      <div className="in-stage">{body}</div>
    </div>
  );
}

const delay = (s: number): CSSProperties => ({ animationDelay: `${s}s` });

/** Cineko (the neon robot-cat) in the intro; the old per-design colours no longer apply. */
function Mascot({ size = 150 }: { color: string; ink: string; size?: number; cheeks?: boolean }) {
  return <MartyMascot size={size} hat={null} animated />;
}

const STAR = "M12 0 L14.5 9.5 L24 12 L14.5 14.5 L12 24 L9.5 14.5 L0 12 L9.5 9.5 Z";

// ================================================================ Каркас

/** The mockup's 20 terrain rows (perspective: far rows small and faint).
 *  Each row is its own band (from its crests down to the next row's lowest
 *  point, which hides it) drawn once and slid as a compositor layer: the TV
 *  never repaints the SVG while the waves drift, so the lines don't flicker. */
function terrainRows() {
  const N = 20, L = 200, k = (2 * Math.PI) / L;
  const geo = Array.from({ length: N }, (_, i) => {
    const t = i / (N - 1);
    return { t, y0: 362 + Math.pow(t, 1.8) * 345, s: 0.45 + t * 1.75, amp: 15 + 11 * Math.pow(Math.sin(i * 0.9), 2) };
  });
  return geo.map(({ t, y0, s, amp }, i) => {
    const half = 640 / s + L + 24;
    const p1 = i * 1.37, p2 = i * 0.61, p3 = i * 2.11;
    const pts: string[] = [];
    let lastX = -half;
    for (let x = -half; x <= half; x += 8) {
      const y = -amp * (0.55 * Math.sin(k * x + p1) + 0.3 * Math.sin(2 * k * x + p2) + 0.15 * Math.sin(3 * k * x + p3));
      pts.push(`${x.toFixed(1)} ${y.toFixed(1)}`);
      lastX = x;
    }
    const top = Math.floor(y0 - s * amp - 6);
    const next = geo[i + 1];
    const bottom = next ? Math.ceil(next.y0 + next.s * next.amp + 6) : 720;
    const local = ((bottom - y0) / s + 10).toFixed(0);
    return {
      d: `M${pts.join(" L")} L${lastX.toFixed(1)} ${local} L${(-half).toFixed(1)} ${local} Z`,
      tf: `translate(640 ${(y0 - top).toFixed(1)}) scale(${s.toFixed(3)})`,
      top,
      height: bottom - top,
      width: 1280 + Math.ceil((L + 30) * s),
      // One wavelength on screen: the loop is seamless.
      shift: (L * s).toFixed(2),
      sw: 1.1 + t * 1.6,
      op: 0.35 + 0.65 * t,
      delay: i * 0.035,
    };
  });
}

function WaveTerrain() {
  const sw = DESIGN_SWATCH.wireframe;
  const accent = sw.accent;
  const bg = sw.bg;
  const rows = useMemo(() => terrainRows(), []);
  const keyframes = useMemo(
    () => rows.map((r, i) => `@keyframes in-drift-${i}{from{transform:translateX(0)}to{transform:translateX(-${r.shift}px)}}`).join(""),
    [rows],
  );
  return (
    <>
      <style>{keyframes}</style>
      <div className="in-abs in-glow" style={{ left: 280, top: 110, width: 720, height: 380, borderRadius: "50%", background: `radial-gradient(closest-side, ${accent}, transparent)` }} />
      {rows.map((r, i) => (
        <div key={i} className="in-row" style={{ top: r.top, height: r.height, ...delay(r.delay) }}>
          <div className="in-drift" style={{ width: r.width, height: r.height, animationName: `in-drift-${i}` }}>
            <svg viewBox={`0 0 ${r.width} ${r.height}`} width={r.width} height={r.height} aria-hidden="true">
              <g transform={r.tf}>
                <path d={r.d} fill={bg} stroke={accent} strokeWidth={r.sw} strokeOpacity={r.op} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              </g>
            </svg>
          </div>
        </div>
      ))}
      <div className="in-center" style={{ top: 178, gap: 22, color: sw.text, fontFamily: "Unbounded, Onest, sans-serif" }}>
        <div style={{ width: 150, height: 170, overflow: "hidden", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div className="in-pop" style={delay(0.5)}>
            <Mascot color={accent} ink="#140a26" />
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, paddingBottom: 10 }}>
          <div style={{ display: "flex", fontSize: 118, fontWeight: 800, lineHeight: 1, letterSpacing: -4 }}>
            {"cineko".split("").map((c, i) => (
              <span key={i} className="in-drop" style={delay(0.85 + i * 0.07)}>
                <span className="in-bob" style={delay(i * 0.15)}>{c}</span>
              </span>
            ))}
          </div>
          <div style={{ position: "relative" }}>
            <div className="in-pill" style={{ background: accent, color: "#140a26", fontSize: 88, fontWeight: 800, lineHeight: 1, padding: "6px 22px 14px", borderRadius: 30, letterSpacing: -2 }}>tv</div>
            <Star size={30} color={sw.text} style={{ right: -26, top: -22 }} at={1.65} />
            <Star size={18} color={accent} style={{ right: -40, top: 30 }} at={1.9} />
            <Star size={22} color={sw.text} style={{ left: -14, top: -30 }} at={2.15} />
          </div>
        </div>
      </div>
    </>
  );
}

function Star({ size, color, style, at }: { size: number; color: string; style: CSSProperties; at: number }) {
  return (
    <svg className="in-star" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ position: "absolute", ...style, ...delay(at) }}>
      <path d={STAR} fill={color} />
    </svg>
  );
}

// ================================================================ Кинозал

function Curtains() {
  const sw = DESIGN_SWATCH.kinozal;
  const bulbs = (top: number) => (
    <div className="in-abs" style={{ top, left: 40, width: 1200, display: "flex", justifyContent: "space-between" }}>
      {Array.from({ length: 30 }, (_, i) => (
        <div key={i} className="in-bulb" style={{ background: sw.accent, ...delay((i % 6) * 0.13) }} />
      ))}
    </div>
  );
  return (
    <>
      <div className="in-abs" style={{ width: 1280, height: 720, background: `radial-gradient(ellipse 55% 45% at 50% 48%, rgba(200,255,61,.16), transparent)` }} />
      <div className="in-center in-zoom" style={{ top: 250, gap: 24, color: sw.text, fontFamily: "Unbounded, Onest, sans-serif", ...delay(0.95) }}>
        <Mascot color={sw.accent} ink={sw.bg} size={130} />
        <div style={{ display: "flex", alignItems: "center", gap: 14, paddingBottom: 8 }}>
          <span style={{ fontSize: 112, fontWeight: 800, letterSpacing: -4, lineHeight: 1 }}>cineko</span>
          <span style={{ background: sw.accent, color: sw.bg, fontSize: 84, fontWeight: 800, lineHeight: 1, padding: "6px 20px 14px", borderRadius: 26 }}>tv</span>
        </div>
      </div>
      <p className="in-abs in-up" style={{ top: 470, width: 1280, textAlign: "center", fontSize: 24, letterSpacing: ".4em", color: "rgba(242,244,248,.6)", fontFamily: "Onest, sans-serif", ...delay(1.4) }}>
        КИНОЗАЛ ОТКРЫТ
      </p>
      <div className="in-curtain in-curtain-l" />
      <div className="in-curtain in-curtain-r" />
      {bulbs(18)}
      {bulbs(692)}
    </>
  );
}

// ================================================================ Терминал

const BOOT = [
  "[ OK ] mount /catalog ........ tmdb",
  "[ OK ] link prowlarr ......... ready",
  "[ OK ] link torrserver ....... ready",
  "[ OK ] load profiles ......... done",
  "[ OK ] tune remote ........... ok",
  "> martytv --start",
];

function TerminalBoot() {
  const sw = DESIGN_SWATCH.terminal;
  const mono = "'JetBrains Mono', ui-monospace, monospace";
  const corner = (s: CSSProperties) => <div className="in-abs" style={{ width: 40, height: 40, borderColor: sw.accent, borderStyle: "solid", borderWidth: 0, ...s }} />;
  return (
    <>
      <div className="in-abs in-scan" style={{ width: 1280, height: 720 }} />
      {corner({ left: 40, top: 36, borderLeftWidth: 4, borderTopWidth: 4 })}
      {corner({ left: 1200, top: 36, borderRightWidth: 4, borderTopWidth: 4 })}
      {corner({ left: 40, top: 644, borderLeftWidth: 4, borderBottomWidth: 4 })}
      {corner({ left: 1200, top: 644, borderRightWidth: 4, borderBottomWidth: 4 })}
      <div className="in-abs" style={{ left: 96, top: 90, fontFamily: mono, fontSize: 21, lineHeight: 1.75, color: "rgba(236,236,232,.72)" }}>
        {BOOT.map((l, i) => (
          <div key={i} className="in-line" style={{ ...delay(0.1 + i * 0.14), color: l.startsWith(">") ? sw.text : undefined }}>
            {l.startsWith("[ OK ]") ? (
              <>
                <span style={{ color: sw.accent }}>[ OK ]</span>
                {l.slice(6)}
              </>
            ) : (
              l
            )}
          </div>
        ))}
      </div>
      <div className="in-abs" style={{ left: 96, top: 380, fontFamily: mono, fontWeight: 500, fontSize: 132, lineHeight: 1, color: sw.text, letterSpacing: -2, display: "flex", alignItems: "center" }}>
        <span className="in-type">
          CINEKO<span style={{ color: sw.accent }}>.</span>
        </span>
        <span className="in-line" style={{ ...delay(1.95), background: sw.accent, color: sw.bg, padding: "0 18px", marginLeft: 8 }}>TV</span>
        <span className="in-cursor" style={{ display: "inline-block", width: 56, height: 118, background: sw.text, marginLeft: 18 }} />
      </div>
      <div className="in-abs in-line" style={{ left: 100, top: 560, fontFamily: mono, fontSize: 20, letterSpacing: ".2em", color: "rgba(236,236,232,.5)", ...delay(2.15) }}>
        SYSTEM READY · ВСЁ ГОТОВО К ПРОСМОТРУ
      </div>
    </>
  );
}

// ================================================================ Проектор

function FilmLeader() {
  const sw = DESIGN_SWATCH.projector;
  const strip = (left: number) => (
    <div className="in-abs" style={{ left, top: 0, width: 46, height: 720, overflow: "hidden", background: "rgba(255,255,255,.04)" }}>
      <div className="in-perf" style={{ display: "flex", flexDirection: "column", gap: 34, paddingTop: 14 }}>
        {Array.from({ length: 13 }, (_, i) => (
          <div key={i} style={{ width: 22, height: 30, marginLeft: 12, borderRadius: 5, background: "rgba(244,248,248,.18)" }} />
        ))}
      </div>
    </div>
  );
  return (
    <>
      {strip(24)}
      {strip(1210)}
      <svg className="in-abs in-leader" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <line x1="640" y1="110" x2="640" y2="550" stroke={sw.text} strokeOpacity=".35" strokeWidth="2" />
        <line x1="380" y1="330" x2="900" y2="330" stroke={sw.text} strokeOpacity=".35" strokeWidth="2" />
        <path className="in-sweep" d="M640 330 L640 140 A190 190 0 0 1 830 330 Z" fill={sw.accent} fillOpacity=".28" />
        <circle cx="640" cy="330" r="190" fill="none" stroke={sw.text} strokeOpacity=".7" strokeWidth="4" />
        <circle cx="640" cy="330" r="150" fill="none" stroke={sw.text} strokeOpacity=".45" strokeWidth="3" />
        {["3", "2", "1"].map((n, i) => (
          <text key={n} className="in-count" style={delay(i * 0.5)} x="640" y="378" textAnchor="middle" fontSize="150" fontWeight="700" fill={sw.text} fontFamily="Onest, sans-serif">
            {n}
          </text>
        ))}
      </svg>
      <svg className="in-abs in-beam" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <defs>
          <linearGradient id="in-beam-g" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={sw.accent} stopOpacity=".55" />
            <stop offset="1" stopColor={sw.accent} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points="610,0 670,0 1000,720 280,720" fill="url(#in-beam-g)" />
      </svg>
      <div className="in-center in-flicker" style={{ top: 228, gap: 24, color: sw.text, fontFamily: "Unbounded, Onest, sans-serif" }}>
        <Mascot color={sw.accent} ink={sw.bg} size={130} />
        <div style={{ display: "flex", alignItems: "center", gap: 14, paddingBottom: 8 }}>
          <span style={{ fontSize: 112, fontWeight: 800, letterSpacing: -4, lineHeight: 1 }}>cineko</span>
          <span style={{ border: `5px solid ${sw.accent}`, color: sw.accent, fontSize: 78, fontWeight: 800, lineHeight: 1, padding: "4px 18px 12px", borderRadius: 999 }}>tv</span>
        </div>
      </div>
    </>
  );
}

// ================================================================ Киберпанк

function Glitch() {
  const sw = DESIGN_SWATCH.cyberpunk;
  const cyan = "#00f0ff";
  const mono = "'JetBrains Mono', ui-monospace, monospace";
  const word = (color: string, extra: CSSProperties = {}, cls = "") => (
    <div className={cls} style={{ position: "absolute", left: 0, top: 0, display: "flex", alignItems: "center", gap: 18, ...extra }}>
      <span style={{ fontSize: 132, fontWeight: 800, letterSpacing: -2, lineHeight: 1, color }}>CINEKO</span>
      <span style={{ fontSize: 96, fontWeight: 800, lineHeight: 1, padding: "8px 26px 14px", background: color === sw.accent ? sw.accent2 : "transparent", color: color === sw.accent ? sw.bg : color,
        clipPath: "polygon(16px 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%, 0 16px)" }}>TV</span>
    </div>
  );
  const slice = (top: number, h: number, at: number) => (
    <div className="in-ghost" style={{ position: "absolute", left: 0, top: 0, width: 760, height: 160, clipPath: `inset(${top}px 0 ${160 - top - h}px 0)`, ...delay(at) }}>
      {word(sw.accent, {}, "in-slice")}
    </div>
  );
  return (
    <>
      <div className="in-abs" style={{ width: 1280, height: 720, backgroundImage: `linear-gradient(rgba(0,240,255,.07) 1px, transparent 1px), linear-gradient(90deg, rgba(0,240,255,.07) 1px, transparent 1px)`, backgroundSize: "64px 64px" }} />
      <div className="in-abs in-scanbar" style={{ width: 1280, height: 6, background: cyan, boxShadow: `0 0 18px ${cyan}`, opacity: 0.85 }} />
      <div className="in-abs" style={{ left: 260, top: 250, width: 760, height: 160, fontFamily: "Unbounded, Onest, sans-serif" }}>
        <div className="in-ghost" style={delay(0.55)}>
          {word(cyan, { transform: "translate(-6px, 3px)" }, "in-glitch")}
        </div>
        <div className="in-ghost" style={delay(0.6)}>
          {word(sw.accent2, { transform: "translate(6px, -3px)" }, "in-glitch")}
        </div>
        <div className="in-fade" style={delay(0.6)}>{word(sw.accent)}</div>
        {slice(30, 26, 0.8)}
        {slice(92, 20, 0.95)}
      </div>
      <div className="in-abs in-fade" style={{ left: 64, top: 48, fontFamily: mono, fontSize: 20, color: cyan, letterSpacing: ".15em", ...delay(0.2) }}>
        SYS://CINEKO <span className="in-hud" style={{ color: sw.accent2 }}>■</span> LINK OK
      </div>
      <div className="in-abs in-fade" style={{ left: 260, top: 440, fontFamily: mono, fontSize: 22, color: "rgba(238,246,255,.6)", letterSpacing: ".3em", ...delay(1.5) }}>
        // НЕОН. КИНО. ПРЯМО СЕЙЧАС
      </div>
      <div className="in-abs" style={{ left: 1100, top: 640, width: 120, height: 6, background: sw.accent2 }} />
      <div className="in-abs" style={{ left: 64, top: 640, width: 220, height: 6, background: sw.accent }} />
    </>
  );
}

// ================================================================ Ар-деко

function Sunburst() {
  const sw = DESIGN_SWATCH.deco;
  const rays: ReactNode[] = [];
  for (let i = 0; i < 25; i++) {
    const a = Math.PI + (i / 24) * Math.PI;
    const a1 = a - 0.025, a2 = a + 0.025, R = 760;
    rays.push(<polygon key={i} points={`640,720 ${640 + R * Math.cos(a1)},${720 + R * Math.sin(a1)} ${640 + R * Math.cos(a2)},${720 + R * Math.sin(a2)}`} fill={sw.accent} fillOpacity={i % 2 ? 0.1 : 0.2} />);
  }
  // A half sunburst fan (the deco ornament beside the title).
  const fan = () => (
    <svg viewBox="0 0 124 66" width="124" height="66" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5, 6].map((i) => {
        const a = Math.PI + (i / 6) * Math.PI;
        return <line key={i} x1="62" y1="62" x2={62 + 54 * Math.cos(a)} y2={62 + 54 * Math.sin(a)} stroke={sw.accent} strokeWidth="2" />;
      })}
      <path d="M4 62 A58 58 0 0 1 120 62" fill="none" stroke={sw.accent2} strokeWidth="2" />
      <line x1="0" y1="63" x2="124" y2="63" stroke={sw.accent} strokeWidth="2" />
    </svg>
  );
  return (
    <>
      <svg className="in-abs in-burst" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        {rays}
      </svg>
      <svg className="in-abs" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <rect className="in-draw" pathLength={1000} x="70" y="60" width="1140" height="600" fill="none" stroke={sw.accent} strokeWidth="3" />
        <rect className="in-draw" pathLength={1000} x="86" y="76" width="1108" height="568" fill="none" stroke={sw.accent2} strokeOpacity=".6" strokeWidth="1.5" style={delay(0.45)} />
      </svg>
      <div className="in-abs in-up" style={{ top: 186, width: 1280, display: "flex", justifyContent: "center", ...delay(0.7) }}>
        <Mascot color={sw.accent} ink={sw.bg} size={110} cheeks={false} />
      </div>
      <div className="in-abs in-up" style={{ top: 316, width: 1280, display: "flex", justifyContent: "center", alignItems: "center", gap: 28, ...delay(0.95) }}>
        {fan()}
        <span style={{ fontFamily: "'Playfair Display', Georgia, serif", fontWeight: 700, fontSize: 120, lineHeight: 1, color: sw.accent2, letterSpacing: ".02em" }}>
          Cineko<span style={{ color: sw.accent }}>TV</span>
        </span>
        {fan()}
      </div>
      <div className="in-abs in-rule" style={{ left: 390, top: 476, width: 500, height: 2, background: sw.accent }} />
      <div className="in-abs in-rule" style={{ left: 440, top: 484, width: 400, height: 1, background: sw.accent2, ...delay(1.4) }} />
      <p className="in-abs in-fade" style={{ top: 506, width: 1280, textAlign: "center", fontFamily: "'Playfair Display', Georgia, serif", fontStyle: "italic", fontSize: 30, color: "rgba(243,234,214,.75)", ...delay(1.6) }}>
        Сейчас на экране
      </p>
    </>
  );
}

// ================================================================ Ретро 80-е

const TAPE = ["#ff3b5c", "#ff7a1a", "#ffd23a", "#16e0d0"];

/** VCR: «PLAY ▶» on blue noise, tracking bars roll, then a chrome logo over a striped sunset and tape stripes. */
function VhsPlay() {
  const sw = DESIGN_SWATCH.retro80;
  const vcr = "'JetBrains Mono', ui-monospace, monospace";
  return (
    <>
      <div className="in-abs" style={{ width: 1280, height: 720, background: "linear-gradient(180deg, #0b0e2a 0%, #1a1240 70%, #34103e 100%)" }} />
      {/* The sun rises behind the horizon (stripes cut in the navy). */}
      <div className="in-abs r8i-sun" style={{ left: 440, top: 300, width: 400, height: 400, borderRadius: "50%", background: "linear-gradient(180deg, #ffd23a 0%, #ff7a1a 50%, #ff3b8c 100%)" }} />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="in-abs" style={{ left: 420, top: 470 + i * 26 + i * i * 2, width: 440, height: 4 + i * 2.5, background: "#1a1240" }} />
      ))}
      <div className="in-abs" style={{ left: 0, top: 560, width: 1280, height: 160, background: "linear-gradient(180deg, #0b0e2a 0%, #0b0e2a 100%)" }} />
      {/* Tape stripes sweep in under the logo. */}
      <svg className="in-abs r8i-stripes" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        {TAPE.map((c, i) => (
          <polygon key={c} points={`0,${640 - i * 22} 0,${618 - i * 22} 1280,${470 - i * 22} 1280,${492 - i * 22}`} fill={c} />
        ))}
      </svg>
      {/* Static noise bands roll down like a VCR finding the tracking. */}
      <div className="in-abs r8i-noise" style={{ width: 1280, height: 720 }}>
        <div style={{ position: "absolute", left: 0, top: 120, width: 1280, height: 26, background: "repeating-linear-gradient(90deg, rgba(255,255,255,.55) 0 3px, rgba(255,255,255,.08) 3px 9px, rgba(255,255,255,.4) 9px 11px, rgba(255,255,255,0) 11px 20px)" }} />
        <div style={{ position: "absolute", left: 0, top: 420, width: 1280, height: 14, background: "repeating-linear-gradient(90deg, rgba(255,255,255,.35) 0 5px, rgba(255,255,255,0) 5px 14px)" }} />
      </div>
      <div className="in-abs r8i-blue" style={{ width: 1280, height: 720, background: "#1f2bd8" }} />
      <div className="in-abs" style={{ left: 64, top: 44, fontFamily: vcr, fontWeight: 500, fontSize: 40, color: "#fff", letterSpacing: ".08em", textShadow: "3px 3px 0 rgba(0,0,0,.45)" }}>
        <span className="r8i-osd">PLAY ▶</span>
      </div>
      <div className="in-abs in-fade" style={{ left: 1004, top: 646, fontFamily: vcr, fontSize: 26, color: "#fff", letterSpacing: ".08em", ...delay(0.2) }}>
        SP 0:00:03
      </div>
      {/* Chrome logo: MARTY (horizon gradient) + the tape-teal TV block. */}
      <div className="in-abs r8i-logo" style={{ top: 214, width: 1280, display: "flex", justifyContent: "center", alignItems: "center", gap: 24 }}>
        <Mascot color={sw.accent} ink={sw.bg} size={128} />
        <span style={{ fontFamily: "'Russo One', Unbounded, sans-serif", fontStyle: "italic", fontSize: 150, lineHeight: 1.1, padding: "0 .12em 0 0",
          backgroundImage: "linear-gradient(180deg, #ffffff 0%, #d8e6ff 38%, #6a7dff 50%, #ffb04a 53%, #ff7a1a 74%, #ffe7a0 100%)",
          WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent", WebkitTextFillColor: "transparent" }}>
          CINEKO
        </span>
        <span className="r8i-tv" style={{ fontFamily: "'Russo One', Unbounded, sans-serif", fontStyle: "italic", fontSize: 104, lineHeight: 1, padding: "8px 26px 14px", background: sw.accent2, color: sw.bg, transform: "skewX(-10deg)" }}>TV</span>
      </div>
      <div className="in-abs in-fade" style={{ top: 150, width: 1280, textAlign: "center", fontFamily: "'Russo One', sans-serif", fontSize: 30, letterSpacing: ".34em", color: "#ffd23a", ...delay(1.7) }}>
        ВИДЕОСАЛОН ОТКРЫТ
      </div>
      <div className="in-abs in-scan" style={{ width: 1280, height: 720 }} />
    </>
  );
}

// ================================================================ Ретро 90-е

/** Windows 95-style boot: sky with clouds, a bevelled window, a block progress bar, then the taskbar. */
function Win95Boot() {
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

// ================================================================ Поп-арт

/** A regular comic starburst (spikes alternating between r1 and r2, wider than tall). */
function burst(cx: number, cy: number, r1: number, r2: number, n: number): string {
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = (i % 2 ? r1 : r2) * (i % 4 === 0 ? 1.06 : 1);
    pts.push(`${(cx + Math.cos(a) * r * 1.25).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`);
  }
  return pts.join(" ");
}

const POP_BURST = burst(640, 372, 178, 262, 16);

/** Comic page: Ben-Day dots, panels slide in, speed lines, a white burst, the logo drops in, Cineko says «ВАУ!». */
function ComicPop() {
  const sw = DESIGN_SWATCH.popart;
  const comic = "'Rubik Mono One', Unbounded, sans-serif";
  const ink = "3px 0 #000, -3px 0 #000, 0 3px #000, 0 -3px #000, 2px 2px #000, -2px -2px #000, 2px -2px #000, -2px 2px #000";
  return (
    <>
      <div className="in-abs" style={{ width: 1280, height: 720, backgroundColor: sw.bg, backgroundImage: "radial-gradient(circle, rgba(255,255,255,.16) 0px, rgba(255,255,255,.16) 3px, rgba(255,255,255,0) 3.6px)", backgroundSize: "20px 20px" }} />
      <svg className="in-abs pai-lines" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        {Array.from({ length: 36 }, (_, i) => {
          const a = (i / 36) * Math.PI * 2;
          return <line key={i} x1={640 + Math.cos(a) * 320} y1={372 + Math.sin(a) * 250} x2={640 + Math.cos(a) * 1000} y2={372 + Math.sin(a) * 800} stroke="#fff" strokeOpacity=".28" strokeWidth={i % 2 ? 4 : 9} />;
        })}
      </svg>
      {/* Corner panels in black ink: red and yellow. */}
      <svg className="in-abs pai-slide-l" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <polygon points="-10,-10 470,-10 290,230 -10,180" fill={sw.accent2} stroke="#000" strokeWidth="8" />
      </svg>
      <svg className="in-abs pai-slide-r" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <polygon points="1290,730 800,730 990,500 1290,540" fill={sw.accent} stroke="#000" strokeWidth="8" />
      </svg>
      <svg className="in-abs pai-burst" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <polygon points={POP_BURST} fill="#000" transform="translate(14 14)" />
        <polygon points={POP_BURST} fill="#fff" stroke="#000" strokeWidth="8" strokeLinejoin="round" />
      </svg>
      <div className="in-abs in-pop" style={{ left: 120, top: 150, ...delay(0.85) }}>
        <Mascot color={sw.accent} ink="#000" size={175} />
      </div>
      {/* Speech balloon from Cineko. */}
      <div className="in-abs pai-bubble" style={{ left: 290, top: 70, width: 220, height: 130, ...delay(1.75) }}>
        <svg viewBox="0 0 220 130" width="220" height="130" aria-hidden="true" style={{ position: "absolute", left: 0, top: 0 }}>
          <path d="M110 6 C 168 6 214 30 214 58 C 214 86 168 108 110 108 C 98 108 88 107 78 105 L 40 126 L 52 98 C 22 89 6 74 6 58 C 6 30 52 6 110 6 Z" fill="#fff" stroke="#000" strokeWidth="6" strokeLinejoin="round" />
        </svg>
        <span style={{ position: "absolute", left: 0, top: 36, width: 220, textAlign: "center", fontFamily: comic, fontSize: 34, lineHeight: 1, color: sw.accent2, textShadow: "2px 2px 0 #000" }}>ВАУ!</span>
      </div>
      <div className="in-abs" style={{ top: 312, width: 1280, display: "flex", justifyContent: "center", alignItems: "center", paddingLeft: 90 }}>
        <div style={{ display: "flex", fontFamily: comic, fontSize: 104, lineHeight: 1, color: sw.accent, textShadow: `${ink}, 8px 8px 0 ${sw.accent2}, 10px 10px 0 #000` }}>
          {"CINEKO".split("").map((c, i) => (
            <span key={i} className="in-drop" style={delay(1.05 + i * 0.07)}>
              {c}
            </span>
          ))}
        </div>
        <span className="pai-tv" style={{ marginLeft: 26, fontFamily: comic, fontSize: 80, lineHeight: 1, padding: "10px 20px 14px", background: sw.accent2, color: "#fff", border: "6px solid #000", boxShadow: "9px 9px 0 #000", textShadow: "3px 3px 0 #000" }}>
          TV
        </span>
      </div>
      {/* The narration box. */}
      <div className="in-abs in-up" style={{ top: 584, width: 1280, textAlign: "center", ...delay(1.95) }}>
        <span style={{ display: "inline-block", fontFamily: comic, fontSize: 24, wordSpacing: "-.35em", color: "#000", background: sw.accent, padding: "10px 22px", border: "5px solid #000", boxShadow: "7px 7px 0 #000" }}>ТЕМ ВРЕМЕНЕМ В КИНОЗАЛЕ…</span>
      </div>
    </>
  );
}

// ================================================================ Конструктивизм

/**
 * A 1920s–30s poster assembling on cream paper: a red circle rolls in with
 * Mayakovsky (this design's mascot) in it, the hammer and sickle stamps in,
 * a black bar draws on a diagonal (the name and a changing slogan on it),
 * «КИНО», «СМОТРИ!», «ГОВОРИТ МОСКВА…».
 */
function PosterDiagonals() {
  const sw = DESIGN_SWATCH.constructivism;
  const grot = "Oswald, 'Russo One', Onest, sans-serif";
  const red = sw.accent;
  const paper = sw.accent2;
  const ink = "#1a1512";
  return (
    <>
      <div className="in-abs" style={{ width: 1280, height: 720, background: paper }} />
      <svg className="in-abs cvi-wedge" viewBox="0 0 1280 720" width="1280" height="720" aria-hidden="true">
        <polygon points="0,720 0,500 620,720" fill={red} />
      </svg>
      <div className="in-abs cvi-line" style={{ left: 640, top: 690, width: 760, height: 8, background: ink, ...delay(0.35) }} />
      <div className="in-abs cvi-line" style={{ left: 720, top: 716, width: 700, height: 3, background: ink, ...delay(0.5) }} />
      {/* The red circle rolls in from the right; Mayakovsky pops up in it. */}
      <div className="in-abs cvi-roll" style={{ left: 700, top: 40, width: 420, height: 420, borderRadius: "50%", background: red }} />
      {/* The black diagonal bar with the name on it. */}
      <div className="in-abs cvi-bar" style={{ left: -60, top: 452, width: 1480, height: 118, background: ink, display: "flex", alignItems: "center" }}>
        <span className="in-fade" style={{ marginLeft: 150, fontFamily: grot, fontWeight: 700, fontSize: 92, letterSpacing: ".06em", color: paper, lineHeight: 1, ...delay(1.1) }}>
          CINEKO<span style={{ color: red }}>·</span>TV
        </span>
        <div className="in-fade" style={{ marginLeft: 56, width: 700, ...delay(1.35) }}>
          <SloganTicker ms={1600} className="whitespace-nowrap" style={{ height: 52, fontFamily: grot, fontWeight: 700, fontSize: 36, lineHeight: "52px", letterSpacing: ".04em", textTransform: "uppercase", color: paper }} />
        </div>
      </div>
      {/* A broadcast caption (text only). */}
      <div data-testid="intro-broadcast" className="in-abs in-fade" style={{ left: 40, top: 656, fontFamily: grot, fontWeight: 700, fontSize: 34, lineHeight: 1, letterSpacing: ".1em", color: paper, ...delay(0.45) }}>
        ГОВОРИТ МОСКВА…
      </div>
      {/* Mayakovsky (this design's mascot) pops up in the red circle as a poster tile; the emblem stamps in at the corner. */}
      <div data-testid="intro-mayakovsky" className="in-abs in-pop" style={{ left: 762, top: 38, ...delay(1.0) }}>
        <img src={MAYAKOVSKY} alt="" width={152} height={201} style={{ display: "block", transform: "rotate(-4deg)", outline: `6px solid ${paper}`, outlineOffset: -6, boxShadow: `10px 10px 0 ${ink}` }} />
      </div>
      <div data-testid="intro-emblem" className="in-abs in-pop" style={{ left: 1142, top: 24, ...delay(1.25) }}>
        <SovietEmblem size={112} />
      </div>
      <div className="in-abs cvi-kino" style={{ left: 64, top: 30, fontFamily: grot, fontWeight: 700, fontSize: 210, lineHeight: 1, letterSpacing: ".02em", color: ink }}>
        КИНО
      </div>
      <div className="in-abs cvi-kino" style={{ left: 70, top: 262, width: 330, height: 14, background: red, ...delay(0.2) }} />
      <div className="in-abs in-up" style={{ left: 930, top: 586, ...delay(1.7) }}>
        <span style={{ display: "inline-block", fontFamily: grot, fontWeight: 700, fontSize: 60, lineHeight: 1, letterSpacing: ".08em", color: paper, background: red, padding: "12px 26px 14px", transform: "rotate(-6deg)" }}>СМОТРИ!</span>
      </div>
    </>
  );
}

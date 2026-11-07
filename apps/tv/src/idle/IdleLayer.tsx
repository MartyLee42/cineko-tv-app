// Home's idle extras on the TV (CatalogShell mounts it while the catalog is
// up): the déjà-vu cat after 2 idle minutes, the screensaver after 10, and
// the secret remote code (↑↑↓↓←→←→ OK: Cineko dances; on the design previews
// every look plays once). Transform/opacity animations only; nothing runs
// until the TV has been left alone.
import { useEffect, useRef, useState } from "react";
import { applyDesign, DESIGNS, getAppliedDesign, Mascot, SovietEmblem, useAppliedDesign, useVideoPlaying } from "@martytv/ui";
import { useCalmMotion } from "../design/skins";
import { CodeMatcher, codeKey, DVD_COLORS, dvdStep, idlePhase, saverPref, type IdlePhase } from "./logic";
import "./idle.css";

/** How long each look shows in the secret design show. */
const SHOW_STEP_MS = 1500;
const DANCE_MS = 3000;

function previewsVisible(): boolean {
  const el = document.querySelector<HTMLElement>('[data-testid="design-previews"]');
  return !!el && el.offsetParent !== null;
}

/**
 * `onHome`: Home's menu screen, nothing over it (no Settings, guide, quiz).
 * The secret code also works while the design previews are on screen.
 */
export function TvIdleLayer({ onHome }: { onHome: boolean }) {
  const design = useAppliedDesign();
  const calm = useCalmMotion();
  const playing = useVideoPlaying();
  const cv = design === "constructivism";
  const [phase, setPhase] = useState<IdlePhase>("none");
  const [dance, setDance] = useState(0);
  const lastKey = useRef(Date.now());
  const catDone = useRef(false);
  const phaseRef = useRef<IdlePhase>("none");
  phaseRef.current = phase;
  const active = onHome && !playing;
  const activeRef = useRef(active);
  activeRef.current = active;

  // Keys: reset the idle clock; a key that wakes the screensaver goes no further.
  useEffect(() => {
    const code = new CodeMatcher();
    let show: ReturnType<typeof setTimeout> | null = null;
    const runShow = () => {
      const mine = getAppliedDesign();
      const looks = [...DESIGNS];
      const step = (i: number) => {
        if (i >= looks.length || !previewsVisible()) {
          if (mine) applyDesign(mine);
          show = null;
          return;
        }
        applyDesign(looks[i]!);
        show = setTimeout(() => step(i + 1), SHOW_STEP_MS);
      };
      step(0);
    };
    const onKey = (e: KeyboardEvent) => {
      lastKey.current = Date.now();
      catDone.current = false;
      if (phaseRef.current === "saver") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setPhase("none");
        return;
      }
      if (phaseRef.current === "cat") setPhase("none");
      if (show !== null) return;
      if (!code.push(codeKey(e))) return;
      // The final OK only finishes the code: it doesn't also press the focused item.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (previewsVisible()) runShow();
      else if (activeRef.current) setDance((n) => n + 1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (show !== null) clearTimeout(show);
    };
  }, []);

  // The idle clock (Home only; it restarts when Home comes back).
  useEffect(() => {
    if (!active) {
      setPhase("none");
      return;
    }
    lastKey.current = Date.now();
    catDone.current = false;
    const id = setInterval(() => {
      const saver = saverPref.get() !== "off";
      const next = idlePhase(Date.now() - lastKey.current, catDone.current, { cat: !cv && !calm, saver });
      if (next !== phaseRef.current) setPhase(next);
    }, 1000);
    return () => clearInterval(id);
  }, [active, cv, calm]);

  useEffect(() => {
    if (!dance) return;
    const t = setTimeout(() => setDance(0), DANCE_MS);
    return () => clearTimeout(t);
  }, [dance]);

  return (
    <>
      {phase === "cat" && active && (
        <DejaVuCat
          onDone={() => {
            catDone.current = true;
            setPhase("none");
          }}
        />
      )}
      {dance > 0 && active && <Dance key={dance} cv={cv} />}
      {phase === "saver" && active && <Screensaver cv={cv} />}
    </>
  );
}

/** A small black Cineko walks along the bottom — and the very same walk again, right away. */
function DejaVuCat({ onDone }: { onDone: () => void }) {
  return (
    <div data-testid="deja-vu-cat" className="idle-cat-track pointer-events-none absolute left-0 z-40" style={{ top: 930, width: 1920, height: 130 }}>
      <div className="idle-cat" onAnimationEnd={onDone}>
        <Mascot mood="run" size={120} animated={false} className="idle-cat-img" />
      </div>
    </div>
  );
}

function Dance({ cv }: { cv: boolean }) {
  return (
    <div data-testid="secret-dance" className="pointer-events-none absolute z-50" style={{ left: 810, top: 640, width: 300, height: 300 }}>
      <div className="idle-dance">{cv ? <SovietEmblem size={260} /> : <Mascot mood="excited" size={300} animated={false} />}</div>
    </div>
  );
}

function Screensaver({ cv }: { cv: boolean }) {
  const [style] = useState(() => saverPref.get());
  return (
    <div data-testid="screensaver" data-saver={style} className="idle-saver absolute left-0 top-0 z-[60]" style={{ width: 1920, height: 1080 }}>
      {style === "dvd" ? <DvdLogo cv={cv} /> : <SleepingCineko cv={cv} />}
    </div>
  );
}

function SleepingCineko({ cv }: { cv: boolean }) {
  return (
    <div className="idle-drift absolute" style={{ left: 760, top: 380, width: 400, height: 320 }}>
      <div className="absolute" style={{ left: 60, top: 60 }}>
        {cv ? <SovietEmblem size={240} /> : <Mascot mood="sleepy" size={260} animated />}
      </div>
      {[0, 1, 2].map((i) => (
        <span key={i} className={`idle-zzz idle-zzz-${i} absolute font-display text-accent`} style={{ left: 300 + i * 26, top: 70 - i * 24, fontSize: 40 + i * 14 }}>
          Z
        </span>
      ))}
    </div>
  );
}

/** The logo's box: the picture fills it exactly, so it touches every edge. */
const DVD_W = 400;
const DVD_H = 180;
/** «Конструктивизм»: the emblem (a disc) instead. */
const CV_SIZE = 170;

/**
 * A still picture (no animation inside) bouncing between the edges at a
 * fixed angle — 45°-ish, like the original — with a new colour on every wall.
 */
function DvdLogo({ cv }: { cv: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [color, setColor] = useState(0);
  const w = cv ? CV_SIZE : DVD_W;
  const h = cv ? CV_SIZE : DVD_H;
  useEffect(() => {
    let b = { x: 300, y: 200, vx: 140, vy: 140 };
    let last = 0;
    let raf = 0;
    const frame = (t: number) => {
      const s = dvdStep(b, last ? t - last : 0, 1920, 1080, w, h);
      last = t;
      b = s;
      if (s.bounced) setColor((c) => (c + 1) % DVD_COLORS.length);
      if (box.current) box.current.style.transform = `translate3d(${Math.round(s.x)}px,${Math.round(s.y)}px,0)`;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [w, h]);
  const c = DVD_COLORS[color]!;
  return (
    <div ref={box} data-testid="dvd-logo" data-color={color} className="idle-dvd absolute left-0 top-0" style={{ width: w, height: h, color: c }}>
      {cv ? <SovietEmblem size={CV_SIZE} color={c} /> : <DvdMark />}
    </div>
  );
}

/** «cineko» over a «TV» disc, the old DVD-Video layout; fills its viewBox edge to edge, in currentColor. */
function DvdMark() {
  return (
    <svg width={DVD_W} height={DVD_H} viewBox="0 0 400 180" fill="currentColor" aria-hidden focusable="false" className="block">
      <text
        x="200"
        y="96"
        textAnchor="middle"
        fontSize="112"
        fontWeight="800"
        textLength="400"
        lengthAdjust="spacingAndGlyphs"
        style={{ fontFamily: "var(--mt-font-display), sans-serif" }}
      >
        cineko
      </text>
      <ellipse cx="200" cy="146" rx="200" ry="34" />
      <text x="200" y="160" textAnchor="middle" fontSize="40" fontWeight="800" fill="#000" letterSpacing="12" style={{ fontFamily: "var(--mt-font-display), sans-serif" }}>
        TV
      </text>
    </svg>
  );
}
